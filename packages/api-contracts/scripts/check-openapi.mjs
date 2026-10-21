import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';

const packageFile = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
const specFile = fileURLToPath(
  new URL('../../../specs/spec-01-foundation-wave-0a/openapi.yaml', import.meta.url),
);
const packaged = YAML.parse(await readFile(packageFile, 'utf8'));
const approved = YAML.parse(await readFile(specFile, 'utf8'));
const gpsPackageFile = fileURLToPath(new URL('../openapi.gps.design.yaml', import.meta.url));
const gpsSpecFile = fileURLToPath(
  new URL('../../../specs/spec-02-android-agent-wave-1/openapi.design.yaml', import.meta.url),
);
assert.deepEqual(packaged, approved, 'versioned OpenAPI must match SPEC-01');
await SwaggerParser.validate(packageFile);
await SwaggerParser.validate(
  fileURLToPath(new URL('../../../specs/spec-mdm-manageengine/openapi.yaml', import.meta.url)),
);
assert.equal(packaged.openapi, '3.1.0');
for (const path of [
  '/health/live',
  '/health/ready',
  '/v1/device/enrollment/claims',
  '/v1/device/sessions',
  '/v1/device/keys/rotate',
]) {
  assert.ok(packaged.paths[path], 'required path missing');
}
for (const name of ['adminCookie', 'csrfHeader', 'deviceBearer', 'deviceProof']) {
  assert.ok(packaged.components.securitySchemes[name], 'security scheme missing');
}
assert.deepEqual(
  packaged.paths['/v1/device/enrollment/claims'].post.requestBody.content['application/json']
    .schema,
  { $ref: '#/components/schemas/ClaimRequest' },
);
const gpsPackaged = YAML.parse(await readFile(gpsPackageFile, 'utf8'));
const gpsDesign = YAML.parse(await readFile(gpsSpecFile, 'utf8'));
assert.deepEqual(gpsPackaged, gpsDesign, 'GPS design copy must match SPEC-02');
await SwaggerParser.validate(gpsPackageFile);
assert.deepEqual(gpsPackaged.paths['/v2/device/config']?.get?.security,
  [{ deviceBearer: [], deviceProof: [] }]);
assert.deepEqual(gpsPackaged.paths['/v3/device/gps/batches']?.post?.security,
  [{ deviceBearer: [], deviceProof: [] }]);
assert.equal(gpsPackaged.components.schemas.ConfigSnapshotV2.properties.schema_version.const, 2);
assert.equal(gpsPackaged.components.schemas.GpsMixedBatchV3.properties.schema_version.const, 3);
const continuityRoute = gpsPackaged.paths['/v1/admin/gps-continuity/alerts']?.get;
assert.equal(continuityRoute?.operationId, 'listGpsContinuityAlertsV1');
assert.deepEqual(continuityRoute?.security, [{ adminCookie: [] }]);
assert.equal(
  continuityRoute?.responses['200']?.content['application/json'].schema.$ref,
  '#/components/schemas/GpsContinuityAlertListV1',
);
for (const status of ['401', '403', '404', '422', '429', '503'])
  assert.ok(continuityRoute?.responses[status], `continuity route missing ${status}`);
const continuitySchema = gpsPackaged.components.schemas.GpsContinuityAlertListV1;
assert.equal(continuitySchema.properties.schema_version.const, 1);
assert.deepEqual(continuitySchema.properties.items.items.properties.reason_code.enum, [
  'CAPTURE_STALE',
  'COMMUNICATION_MISSING',
]);
assert.deepEqual(
  gpsPackaged.components.schemas.AlertList.properties.items.items.properties.reason_code.enum,
  ['COMMUNICATION_MISSING', 'UNKNOWN'],
  'legacy AlertList remains unchanged',
);
for (const path of [
  '/v1/admin/gps-policies',
  '/v1/admin/gps-groups',
  '/v1/admin/gps-policies/{id}/publish',
  '/v1/device/health/batches',
  '/v1/device/gps-session-events/batches',
  '/v1/device/locations/batches',
  '/v1/admin/devices/{device_id}/gps-sessions',
  '/v1/admin/devices/{device_id}/locations',
  '/v1/admin/devices/{id}/health',
  '/v1/admin/gps-capabilities',
  '/v1/admin/users',
  '/v1/admin/users/invitations/accept',
  '/v1/admin/users/{id}/invitations',
  '/v1/admin/users/{id}/capabilities',
  '/v1/admin/users/{id}/tenant-access',
  '/v1/admin/users/{id}/revoke',
  '/v1/admin/gps-devices',
  '/v1/admin/gps-installations',
  '/v1/admin/gps-installations/{id}/retire',
  '/v1/admin/gps-tenant-grants/proposals',
  '/v1/admin/gps-tenant-grants/{id}/approve',
  '/v1/admin/enrollment/devices',
  '/v1/admin/devices/{device_id}/invitations/{invitation_id}',
]) {
  assert.ok(gpsPackaged.paths[path], 'required GPS design path missing');
}
for (const path of [
  '/v1/admin/gps-installations',
  '/v1/admin/gps-installations/{id}/retire',
  '/v1/admin/gps-tenant-grants/proposals',
  '/v1/admin/gps-tenant-grants/{id}/approve',
  '/v1/admin/users',
  '/v1/admin/users/{id}/invitations',
  '/v1/admin/users/{id}/capabilities',
  '/v1/admin/users/{id}/tenant-access',
  '/v1/admin/users/{id}/revoke',
])
  assert.deepEqual(gpsPackaged.paths[path].post.security, [{ adminCookie: [], csrfHeader: [] }]);
const healthPost = gpsPackaged.paths['/v1/device/health/batches'].post;
for (const path of ['/v1/device/gps-session-events/batches', '/v1/device/locations/batches']) {
  const operation = gpsPackaged.paths[path].post;
  assert.deepEqual(operation.security, [{ deviceBearer: [], deviceProof: [] }]);
  for (const status of ['200', '202', '401', '403', '409', '410', '413', '422', '429', '503'])
    assert.ok(operation.responses[status], `${path} missing ${status}`);
}
assert.deepEqual(healthPost.security, [{ deviceBearer: [], deviceProof: [] }]);
assert.deepEqual(gpsPackaged.paths['/v1/admin/enrollment/devices'].get.security, [
  { adminCookie: [] },
]);
assert.deepEqual(
  gpsPackaged.paths['/v1/admin/devices/{device_id}/invitations/{invitation_id}'].delete.security,
  [{ adminCookie: [], csrfHeader: [] }],
);
assert.ok(healthPost.responses['200'] && !healthPost.responses['202']);
assert.deepEqual(healthPost.parameters, []);
const healthEvent = gpsPackaged.components.schemas.HealthEvent;
for (const name of [
  'boot_id',
  'capture_anchor_id',
  'anchor_elapsed_realtime_ms',
  'elapsed_realtime_ms',
  'observed_at',
  'due_at',
  'battery_percent',
])
  assert.ok(healthEvent.required.includes(name), `health event missing ${name}`);
assert.equal(gpsPackaged.components.schemas.PolicyInput.properties.health_interval_s.minimum, 60);
assert.equal(gpsPackaged.components.schemas.PolicyInput.properties.health_interval_s.maximum, 3600);
process.stdout.write('OpenAPI 3.1 validated against SPEC-01, SPEC-02 and MDM design.\n');
