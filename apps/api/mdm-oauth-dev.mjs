import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DiagnosticError, DiagnosticSession, equalSecret, loadLocalConfig, randomUrlSafe } from './mdm-oauth-core.mjs';
import { saveLocalMdmGrant } from './mdm-oauth-secret-export.mjs';

const PORT = 3500;
const ORIGIN = 'http://localhost:' + PORT;
const COOKIE = 'geops_mdm_oauth_flow';
const SAVE_REFRESH = process.env.GEOPS_MDM_SAVE_REFRESH === '1';
const CONFIG_PATH = process.env.GEOPS_MDM_LOCAL_CONFIG_PATH ?? join(dirname(fileURLToPath(import.meta.url)), '.env.local');
const GRANT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infrastructure', 'compose', '.local', 'staging', 'mdm');
const csrfToken = randomUrlSafe(32);

function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self' " + session.config.authOrigin + "; base-uri 'none'; frame-ancestors 'none'");
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function redirect(response, location, cookie = null) {
  response.statusCode = 303;
  response.setHeader('Location', location);
  if (cookie !== null) response.setHeader('Set-Cookie', cookie);
  response.end();
}

function cookieValue(request) {
  const header = request.headers.cookie || '';
  const item = header.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
  return item ? item.slice(COOKIE.length + 1) : null;
}

function flowCookie(value) {
  return COOKIE + '=' + value + '; Max-Age=300; Path=/api/integrations/mdm/oauth; HttpOnly; SameSite=Lax';
}

function clearFlowCookie() {
  return COOKIE + '=; Max-Age=0; Path=/api/integrations/mdm/oauth; HttpOnly; SameSite=Lax';
}

function localRequest(request) {
  return request.headers.host === 'localhost:' + PORT || request.headers.host === '127.0.0.1:' + PORT;
}

async function validLocalPost(request) {
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return false;
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString('utf8');
    if (body.length > 4096) return false;
  }
  return equalSecret(new URLSearchParams(body).get('csrf'), csrfToken);
}

const homepage = `<!doctype html><html lang="es"><meta charset="utf-8"><title>GEOPS · MDM OAuth local</title>
<h1>GEOPS · diagnóstico MDM MSP</h1><p>Solo desarrollo local. Los tokens permanecen en memoria del proceso.</p>
<p>Autorizar inventario solicita MDMOnDemand.MDMInventory.READ. Listar clientes solicita por separado MDMOnDemand.MDMAdmin.READ para buscar DEFAULT_CUSTOMER.</p>
<form method="post" action="/api/integrations/mdm/oauth/start/inventory"><input type="hidden" name="csrf" value="${csrfToken}"><button>Autorizar lectura de inventario</button></form>
<form method="post" action="/api/integrations/mdm/oauth/start/customers"><input type="hidden" name="csrf" value="${csrfToken}"><button>Autorizar búsqueda de DEFAULT_CUSTOMER</button></form>
<p><a href="/api/integrations/mdm/status">Estado sanitario</a> · <a href="/api/integrations/mdm/customers">Buscar cliente</a> · <a href="/api/integrations/mdm/devices?limit=1&offset=0">Listar dispositivos (1)</a></p>
${SAVE_REFRESH ? '<p>Al guardar el grant para Staging de prueba, detén este servidor sin revocarlo. Para revocarlo más tarde, usa Zoho Connected Apps o el endpoint administrativo de GEOPS.</p>' : `<form method="post" action="/api/integrations/mdm/disconnect"><input type="hidden" name="csrf" value="${csrfToken}"><button>Revocar y desconectar</button></form>`}
<p>Las respuestas muestran solo códigos HTTP y estructura resumida. No incluyen tokens ni datos de dispositivos.</p></html>`;

let session;
try {
  session = new DiagnosticSession(loadLocalConfig(CONFIG_PATH));
} catch (error) {
  const code = error instanceof DiagnosticError ? error.code : 'configuration_error';
  process.stderr.write('GEOPS MDM diagnostic unavailable: ' + code + '\n');
  process.exitCode = 1;
}

if (session) {
  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (!localRequest(request)) throw new DiagnosticError('invalid_host', 403);
      const url = new URL(request.url || '/', ORIGIN);
      if (request.method === 'POST' && !(await validLocalPost(request))) throw new DiagnosticError('invalid_csrf', 403);
      if (request.method === 'GET' && url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        const result = url.searchParams.get('result');
        const visible = result && /^[a-z_]+$/.test(result) ? '<p>Resultado OAuth: ' + result + '</p>' : '';
        response.end(homepage.replace('<h1>GEOPS', visible + '<h1>GEOPS'));
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/integrations/mdm/oauth/start/')) {
        const mode = url.pathname.split('/').at(-1);
        const flow = session.begin(mode);
        redirect(response, flow.url, flowCookie(flow.cookie));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/integrations/mdm/oauth/callback') {
        try {
          const completed = await session.complete({
            state: url.searchParams.get('state'),
            code: url.searchParams.get('code'),
            cookie: cookieValue(request),
            location: url.searchParams.get('location'),
            error: url.searchParams.get('error')
          });
          if (completed.mode === 'inventory' && SAVE_REFRESH) {
            try {
              await saveLocalMdmGrant(GRANT_DIR, session.config, session.tokens.inventory?.refreshToken);
            } catch {
              await session.disconnect().catch(() => {});
              throw new DiagnosticError('grant_export_failed', 503);
            }
            redirect(response, '/?result=connected_grant_saved', clearFlowCookie());
          } else {
            redirect(response, '/?result=connected', clearFlowCookie());
          }
        } catch (error) {
          const code = error instanceof DiagnosticError ? error.code : 'oauth_callback_failed';
          redirect(response, '/?result=' + encodeURIComponent(code), clearFlowCookie());
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/integrations/mdm/status') {
        json(response, 200, session.status());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/integrations/mdm/customers') {
        json(response, 200, await session.findDefaultCustomer());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/integrations/mdm/devices') {
        json(response, 200, await session.listDevices({
          limit: url.searchParams.get('limit') ?? 1,
          offset: url.searchParams.get('offset') ?? 0
        }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/integrations/mdm/disconnect') {
        const result = await session.disconnect();
        json(response, (result.remote_revocation_failed || result.remote_refresh_reuse_unverified) ? 502 : 200, result);
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const safe = error instanceof DiagnosticError ? error : new DiagnosticError('internal_error', 500);
      if (safe.retryAfter !== null) response.setHeader('Retry-After', String(safe.retryAfter));
      json(response, safe.httpStatus, { error: safe.code, ...(safe.retryAfter !== null ? { retry_after_seconds: safe.retryAfter } : {}), ...(safe.upstreamStatus !== null ? { upstream_http_status: safe.upstreamStatus } : {}) });
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => process.stderr.write('GEOPS MDM diagnostic listen error\n'));
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(ORIGIN + '/\n'));
}
