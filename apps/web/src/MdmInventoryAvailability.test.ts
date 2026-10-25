import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MdmStatus } from './api/client.js';
import { mdmInventoryAvailability } from './MdmInventoryAvailability.js';

const status: MdmStatus = {
  provider: 'manageengine',
  connected: false,
  authorized: false,
  oauth_configured: false,
  edition_evidence: 'UNVERIFIED',
  last_checked_at: null,
  last_http_status: null,
  sanitized_error_code: 'mdm_oauth_unconfigured',
};

test('inventory waits for OAuth configuration and authorization before requesting devices', () => {
  assert.deepEqual(mdmInventoryAvailability(null), { loadDevices: false, message: null });
  assert.deepEqual(mdmInventoryAvailability(status), {
    loadDevices: false,
    message: 'Configuración OAuth pendiente.',
  });
  assert.deepEqual(mdmInventoryAvailability({ ...status, oauth_configured: true }), {
    loadDevices: false,
    message: 'ManageEngine no conectado.',
  });
  assert.deepEqual(
    mdmInventoryAvailability({ ...status, oauth_configured: true, authorized: true }),
    { loadDevices: true, message: null },
  );
});
