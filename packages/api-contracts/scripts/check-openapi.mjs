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
assert.deepEqual(packaged, approved, 'versioned OpenAPI must match SPEC-01');
await SwaggerParser.validate(packageFile);
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
process.stdout.write(
  'OpenAPI 3.1 validated against SPEC-01; identity paths and security schemes present.\n',
);
