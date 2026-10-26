import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import type { DeviceRepository } from '../device-identity/repository.js';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
import type { MdmPage, MdmProvider } from './provider.js';
import type { MdmInventoryService } from './inventory.js';
import type { MdmOAuthRuntime } from './oauth-runtime.js';
import type { MdmConnectionControl } from './connection-control.js';
import type { MdmWebOAuth } from './web-oauth.js';
import type { MdmTenantRuntime } from './tenant-runtime.js';
import type { MdmOAuthClientStore } from './oauth-client-store.js';

interface PageQuery {
  cursor?: string;
  limit?: string;
}

function page(query: PageQuery): { cursor: string | undefined; limit: number } {
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'invalid_limit', 'Invalid limit');
  }
  if (query.cursor && query.cursor.length > 2048)
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  return { cursor: query.cursor, limit };
}

async function requireInstallationCapability(
  devices: DeviceRepository,
  adminId: string,
  requestId: string,
  action: string,
): Promise<void> {
  try {
    await requireInstallationAccess(devices.pool, adminId, 'synthetic');
  } catch (error) {
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action,
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
    }).catch(() => {});
    throw error;
  }
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  devices: DeviceRepository,
  mdm?: MdmProvider,
  inventory?: MdmInventoryService,
  oauth?: MdmOAuthRuntime,
  control?: MdmConnectionControl,
  webOAuth?: MdmWebOAuth | (() => Promise<MdmWebOAuth | undefined>),
  tenant?: MdmTenantRuntime,
  clientStore?: MdmOAuthClientStore,
): void {
  const guarded = <T>(operation: () => Promise<T>): Promise<T> =>
    control ? control.withConnected(operation) : operation();
  app.get<{ Querystring: PageQuery }>('/v1/admin/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'device.inventory.read');
    const args = page(request.query);
    const result = await devices.list(args.cursor, args.limit);
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'device.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: 'geops', count: result.items.length },
    });
    return result;
  });

  app.get<{ Querystring: PageQuery }>('/v1/admin/enrollment/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(
      devices,
      admin.id,
      request.id,
      'device.enrollment.inventory.read',
    );
    const args = page(request.query);
    const granted = await devices.pool.query<{ permission: string }>(
      `SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL
       AND permission IN ('gps.policy.read','gps.session.read')`,
      [admin.id],
    );
    const rights = new Set(granted.rows.map((row) => row.permission));
    const result = await devices.listEnrollment(
      args.cursor,
      args.limit,
      rights.has('gps.policy.read'),
      rights.has('gps.session.read'),
    );
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'device.enrollment.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { tenant_id: 'synthetic', count: result.items.length },
    });
    return result;
  });

  app.post<{ Body: { display_label: string } }>(
    '/v1/admin/devices',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['display_label'],
          properties: { display_label: { type: 'string', minLength: 1, maxLength: 120 } },
        },
      },
    },
    async (request, reply) => {
      const admin = await requireAdmin(request, auth, true);
      await requireInstallationCapability(devices, admin.id, request.id, 'device.draft.create');
      const record = await devices.createDraft(request.body.display_label, admin.id, request.id);
      reply.code(201);
      return record;
    },
  );

  if (!mdm && !tenant) {
    const disabled = async (request: FastifyRequest): Promise<never> => {
      await requireAdmin(request, auth);
      throw new ApiError(503, 'mdm_disabled', 'MDM disabled');
    };
    app.get('/v1/admin/mdm/status', disabled);
    app.get('/v1/admin/mdm/devices', disabled);
    app.get('/v1/admin/mdm/inventory', disabled);
    app.post('/v1/admin/mdm/sync', disabled);
    app.put('/v1/admin/devices/:device_id/mdm-link', disabled);
    app.delete('/v1/admin/devices/:device_id/mdm-link', disabled);
    app.post('/v1/admin/mdm/disconnect', disabled);
    return;
  }

  if (tenant) {
    registerDiscoveredTenantRoutes(app, auth, devices, tenant, webOAuth, clientStore);
    return;
  }
  if (!mdm) throw new Error('MDM OAuth routes are unavailable');

  app.get('/v1/admin/mdm/status', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.status.read');
    const status = await mdm.integrationStatus();
    status.authorized = control ? await control.isConnected() : false;
    status.authorization_state = control ? await control.authorizationState() : 'never';
    if (!status.authorized) {
      status.connected = false;
      status.sanitized_error_code = 'mdm_disconnected';
    }
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'mdm.status.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: status.provider },
    });
    return status;
  });

  if (webOAuth && typeof webOAuth !== 'function') {
    app.post('/v1/admin/mdm/oauth/start', async (request, reply) => {
      const admin = await requireAdmin(request, auth, true);
      const flow = await webOAuth.start(admin.id, admin.sessionId, request.id);
      reply.header('Cache-Control', 'no-store');
      reply.header(
        'Set-Cookie',
        `${webOAuth.cookieName}=${flow.nonce}; Path=${webOAuth.callbackPath}; Max-Age=300; HttpOnly; SameSite=Lax${webOAuth.secureCookie ? '; Secure' : ''}`,
      );
      return { authorization_url: flow.url };
    });

    app.get<{
      Querystring: {
        state?: string;
        code?: string;
        error?: string;
        location?: string;
      };
    }>(webOAuth.callbackPath, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header(
        'Set-Cookie',
        `${webOAuth.cookieName}=; Path=${webOAuth.callbackPath}; Max-Age=0; HttpOnly; SameSite=Lax${webOAuth.secureCookie ? '; Secure' : ''}`,
      );
      const nonce = request.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${webOAuth.cookieName}=`))
        ?.slice(webOAuth.cookieName.length + 1);
      let outcome = 'failed';
      try {
        await webOAuth.complete({
          state: request.query.state,
          code: request.query.code,
          error: request.query.error,
          location: request.query.location ?? null,
          nonce,
          correlationId: request.id,
        });
        oauth?.clearCache();
        outcome = 'connected';
      } catch (error) {
        await appendAudit(devices.pool, {
          actorType: 'SYSTEM',
          action: 'mdm.oauth.callback',
          outcome: 'rejected',
          correlationId: request.id,
          metadata: { code: error instanceof ApiError ? error.code : 'mdm_oauth_failed' },
        }).catch(() => {});
        // The fixed redirect contains no code, state, grant, or upstream detail.
      }
      return reply.code(303).header('Location', `/status?mdm_oauth=${outcome}`).send();
    });
  }

  app.get<{ Querystring: PageQuery }>('/v1/admin/mdm/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.inventory.read');
    const args = page(request.query);
    let result: MdmPage;
    try {
      result = await guarded(() =>
        mdm.listDevices(inventory?.config.customerId ?? 'synthetic', args.cursor, args.limit),
      );
    } catch (error) {
      await appendAudit(devices.pool, {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'mdm.provider.read',
        outcome: 'rejected',
        correlationId: request.id,
        metadata: { code: error instanceof ApiError ? error.code : 'mdm_upstream_error' },
      }).catch(() => {});
      throw error;
    }
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'mdm.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: result.source, count: result.items.length },
    });
    return result;
  });

  if (inventory) {
    app.get<{ Querystring: { limit?: string; after?: string } }>(
      '/v1/admin/mdm/inventory',
      async (request) => {
        const admin = await requireAdmin(request, auth);
        await requireInstallationCapability(
          devices,
          admin.id,
          request.id,
          'mdm.inventory.cache.read',
        );
        return guarded(() =>
          inventory.list(
            request.query.limit === undefined ? 25 : Number(request.query.limit),
            request.query.after,
          ),
        );
      },
    );

    app.post('/v1/admin/mdm/sync', async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await requireInstallationCapability(devices, admin.id, request.id, 'mdm.inventory.sync');
      return inventory.sync(admin.id, request.id);
    });

    app.put<{ Params: { device_id: string }; Body: { mdm_device_id: string } }>(
      '/v1/admin/devices/:device_id/mdm-link',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['mdm_device_id'],
            properties: {
              mdm_device_id: { type: 'string', pattern: '^[0-9]{1,30}$' },
            },
          },
        },
      },
      async (request) => {
        const admin = await requireAdmin(request, auth, true);
        await guarded(() =>
          inventory.link(
            request.params.device_id,
            request.body.mdm_device_id,
            admin.id,
            request.id,
          ),
        );
        return { linked: true };
      },
    );

    app.delete<{ Params: { device_id: string } }>(
      '/v1/admin/devices/:device_id/mdm-link',
      async (request) => {
        const admin = await requireAdmin(request, auth, true);
        await guarded(() => inventory.unlink(request.params.device_id, admin.id, request.id));
        return { linked: false };
      },
    );

    if (oauth)
      app.post('/v1/admin/mdm/disconnect', async (request) => {
        const admin = await requireAdmin(request, auth, true);
        await requireInstallationCapability(devices, admin.id, request.id, 'mdm.disconnect');
        if (!control) throw new ApiError(503, 'mdm_control_unavailable', 'MDM unavailable');
        const revoked = await control.disconnect(admin.id, request.id, () => oauth.revoke());
        if (revoked) await oauth.removePersistedGrant();
        return { local_disconnected: true, remote_revoked: revoked };
      });

    if (oauth && control)
      app.post<{ Body: { reason: string } }>(
        '/v1/admin/mdm/reconnect',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['reason'],
              properties: { reason: { type: 'string', minLength: 8, maxLength: 240 } },
            },
          },
        },
        async (request) => {
          const admin = await requireAdmin(request, auth, true);
          await requireInstallationCapability(devices, admin.id, request.id, 'mdm.reconnect');
          const extra = await devices.pool.query(
            `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.tenant.grant'
           AND revoked_at IS NULL`,
            [admin.id],
          );
          if (!extra.rowCount) throw new ApiError(403, 'gps_forbidden', 'Forbidden');
          await control.reconnect(
            admin.id,
            request.id,
            () => oauth.token(true),
            request.body.reason,
          );
          return { connected: true };
        },
      );
  }
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function registerDiscoveredTenantRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  devices: DeviceRepository,
  tenant: MdmTenantRuntime,
  oauth?: MdmWebOAuth | (() => Promise<MdmWebOAuth | undefined>),
  clientStore?: MdmOAuthClientStore,
): void {
  const resolveOAuth = async (): Promise<MdmWebOAuth | undefined> =>
    typeof oauth === 'function' ? oauth() : oauth;
  if (clientStore) {
    app.get('/v1/admin/mdm/oauth/config', async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      await requireInstallationCapability(devices, admin.id, request.id, 'mdm.oauth.config.read');
      reply.header('Cache-Control', 'no-store');
      return {
        ...(await clientStore.status()),
        callback_url: clientStore.webOrigin
          ? `${clientStore.webOrigin}/v1/admin/mdm/oauth/callback`
          : null,
      };
    });
    app.put<{ Body: { client_id: string; client_secret: string } }>(
      '/v1/admin/mdm/oauth/config',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['client_id', 'client_secret'],
            properties: {
              client_id: { type: 'string', minLength: 1, maxLength: 2048 },
              client_secret: { type: 'string', minLength: 1, maxLength: 2048 },
            },
          },
        },
      },
      async (request, reply) => {
        const admin = await requireAdmin(request, auth, true);
        await requireInstallationCapability(
          devices,
          admin.id,
          request.id,
          'mdm.oauth.config.write',
        );
        await clientStore.save(
          admin.id,
          request.id,
          request.body.client_id,
          request.body.client_secret,
        );
        reply.header('Cache-Control', 'no-store');
        return { configured: true };
      },
    );
  }
  app.get('/v1/admin/mdm/status', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.status.read');
    return tenant.status();
  });

  app.post('/v1/admin/mdm/oauth/start', async (request, reply) => {
    const admin = await requireAdmin(request, auth, true);
    const activeOAuth = await resolveOAuth();
    if (!activeOAuth) throw new ApiError(503, 'mdm_oauth_unconfigured', 'MDM unavailable');
    const flow = await activeOAuth.start(admin.id, admin.sessionId, request.id);
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Set-Cookie',
      `${activeOAuth.cookieName}=${flow.nonce}; Path=${activeOAuth.callbackPath}; Max-Age=300; HttpOnly; SameSite=Lax${activeOAuth.secureCookie ? '; Secure' : ''}`,
    );
    return { authorization_url: flow.url };
  });

  if (oauth) {
    app.get<{ Querystring: { state?: string; code?: string; error?: string; location?: string } }>(
      '/v1/admin/mdm/oauth/callback',
      async (request, reply) => {
        const activeOAuth = await resolveOAuth();
        reply.header('Cache-Control', 'no-store');
        reply.header('Referrer-Policy', 'no-referrer');
        const cookies = [
          `geops_mdm_oauth=; Path=/v1/admin/mdm/oauth/callback; Max-Age=0; HttpOnly; SameSite=Lax${activeOAuth?.secureCookie ? '; Secure' : ''}`,
        ];
        let outcome = 'failed';
        try {
          if (!activeOAuth) throw new ApiError(503, 'mdm_oauth_unconfigured', 'MDM unavailable');
          const completed = await activeOAuth.complete({
            state: request.query.state,
            code: request.query.code,
            error: request.query.error,
            location: request.query.location ?? null,
            nonce: cookieValue(request, activeOAuth.cookieName),
            correlationId: request.id,
          });
          outcome = completed.kind === 'selection' ? 'select' : 'connected';
          if (completed.kind === 'selection')
            cookies.push(
              `${activeOAuth.selectionCookieName}=${completed.selectionToken}; Path=${activeOAuth.selectionPath}; Max-Age=300; HttpOnly; SameSite=Strict${activeOAuth.secureCookie ? '; Secure' : ''}`,
            );
        } catch (error) {
          await appendAudit(devices.pool, {
            actorType: 'SYSTEM',
            action: 'mdm.oauth.callback',
            outcome: 'rejected',
            correlationId: request.id,
            metadata: { code: error instanceof ApiError ? error.code : 'mdm_oauth_failed' },
          }).catch(() => {});
        }
        reply.header('Set-Cookie', cookies);
        return reply.code(303).header('Location', `/status?mdm_oauth=${outcome}`).send();
      },
    );

    app.get('/v1/admin/mdm/oauth/customers', async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      const activeOAuth = await resolveOAuth();
      if (!activeOAuth) throw new ApiError(503, 'mdm_oauth_unconfigured', 'MDM unavailable');
      reply.header('Cache-Control', 'no-store');
      return {
        customers: await activeOAuth.customers(
          cookieValue(request, activeOAuth.selectionCookieName) ?? '',
          admin.id,
          admin.sessionId,
        ),
      };
    });
    app.post<{ Body: { customer_id: string } }>(
      '/v1/admin/mdm/oauth/customers',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['customer_id'],
            properties: { customer_id: { type: 'string', pattern: '^[0-9]{1,30}$' } },
          },
        },
      },
      async (request, reply) => {
        const admin = await requireAdmin(request, auth, true);
        const activeOAuth = await resolveOAuth();
        if (!activeOAuth) throw new ApiError(503, 'mdm_oauth_unconfigured', 'MDM unavailable');
        await activeOAuth.choose(
          cookieValue(request, activeOAuth.selectionCookieName) ?? '',
          request.body.customer_id,
          admin.id,
          admin.sessionId,
          request.id,
        );
        reply.header('Cache-Control', 'no-store');
        reply.header(
          'Set-Cookie',
          `${activeOAuth.selectionCookieName}=; Path=${activeOAuth.selectionPath}; Max-Age=0; HttpOnly; SameSite=Strict${activeOAuth.secureCookie ? '; Secure' : ''}`,
        );
        return { connected: true };
      },
    );
  }

  app.get<{ Querystring: PageQuery }>('/v1/admin/mdm/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.inventory.read');
    const args = page(request.query);
    return tenant.devices(args.cursor, args.limit);
  });
  app.get<{ Querystring: { limit?: string; after?: string } }>(
    '/v1/admin/mdm/inventory',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      await requireInstallationCapability(
        devices,
        admin.id,
        request.id,
        'mdm.inventory.cache.read',
      );
      return tenant.inventory(
        request.query.limit === undefined ? 25 : Number(request.query.limit),
        request.query.after,
      );
    },
  );
  app.post('/v1/admin/mdm/sync', async (request) => {
    const admin = await requireAdmin(request, auth, true);
    await clientStore?.requireAdmin(admin.id);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.inventory.sync');
    return tenant.sync(admin.id, request.id);
  });
  app.put<{ Params: { device_id: string }; Body: { mdm_device_id: string } }>(
    '/v1/admin/devices/:device_id/mdm-link',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mdm_device_id'],
          properties: { mdm_device_id: { type: 'string', pattern: '^[0-9]{1,30}$' } },
        },
      },
    },
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await clientStore?.requireAdmin(admin.id);
      await tenant.link(request.params.device_id, request.body.mdm_device_id, admin.id, request.id);
      return { linked: true };
    },
  );
  app.delete<{ Params: { device_id: string } }>(
    '/v1/admin/devices/:device_id/mdm-link',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await clientStore?.requireAdmin(admin.id);
      await tenant.unlink(request.params.device_id, admin.id, request.id);
      return { linked: false };
    },
  );
  app.post('/v1/admin/mdm/disconnect', async (request) => {
    const admin = await requireAdmin(request, auth, true);
    await clientStore?.requireAdmin(admin.id);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.disconnect');
    const permission = await devices.pool.query(
      `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.tenant.grant'
       AND revoked_at IS NULL`,
      [admin.id],
    );
    if (!permission.rowCount) throw new ApiError(403, 'mdm_forbidden', 'Forbidden');
    return tenant.disconnect(admin.id, request.id);
  });
}
