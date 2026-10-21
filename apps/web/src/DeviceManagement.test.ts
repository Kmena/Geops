import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device } from './api/client.js';
import { availableActions, filterDevices } from './DeviceManagement.js';

const base: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  display_label: 'Android-Prueba-01',
  status: 'ACTIVE',
  mdm_binding_id: '00000000-0000-4000-8000-000000000002',
  tenant_id: 'synthetic',
  mdm_device_id: 'synthetic-1',
  enrolled_at: null,
  last_communication_at: null,
  invitation_id: null,
  invitation_status: null,
  invitation_expires_at: null,
  claim_id: null,
  claim_status: null,
  key_id: null,
  installation_id: '00000000-0000-4000-8000-000000000003',
  last_installation_retired_at: null,
  policy_name: null,
  session_state: null,
};

test('inventory filters keep suspended and terminal devices discoverable', () => {
  const devices: Device[] = [
    base,
    { ...base, id: 'suspended', status: 'SUSPENDED', installation_id: null },
    {
      ...base,
      id: 'stopped',
      installation_id: null,
      last_installation_retired_at: '2026-10-20T12:00:00Z',
    },
    { ...base, id: 'revoked', status: 'REVOKED', installation_id: null },
    { ...base, id: 'retired', status: 'RETIRED', installation_id: null },
  ];
  assert.equal(filterDevices(devices, 'all').length, 5);
  assert.deepEqual(
    filterDevices(devices, 'active').map((item) => item.id),
    [base.id, 'stopped'],
  );
  assert.deepEqual(
    filterDevices(devices, 'suspended').map((item) => item.id),
    ['suspended'],
  );
  assert.deepEqual(
    filterDevices(devices, 'noGps').map((item) => item.id),
    ['suspended', 'stopped'],
  );
  assert.deepEqual(
    filterDevices(devices, 'revoked').map((item) => item.id),
    ['revoked'],
  );
  assert.deepEqual(
    filterDevices(devices, 'retired').map((item) => item.id),
    ['retired'],
  );
});

test('actions follow the server identity and installation states', () => {
  assert.deepEqual(availableActions(base), ['stopGps', 'suspend', 'revoke', 'retire']);
  assert.deepEqual(availableActions({ ...base, status: 'SUSPENDED', installation_id: null }), [
    'reactivate',
    'revoke',
    'retire',
  ]);
  assert.deepEqual(availableActions({ ...base, status: 'REVOKED', installation_id: null }), [
    'retire',
  ]);
  assert.deepEqual(availableActions({ ...base, status: 'RETIRED', installation_id: null }), []);
});
