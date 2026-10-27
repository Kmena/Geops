#!/usr/bin/env node
/** Sign the fixed nonce-repair installer with the approved operational key. */
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

const [scriptPath, publicPath, privatePath, signaturePath] = process.argv.slice(2);
const APPROVED = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27';
const SCRIPT = '003ea80faea0fbe37acf3a2b197cdbffa63662f141c1a683403c8fb736be5a83';
const sha = (body) => createHash('sha256').update(body).digest('hex');
if (process.argv.length !== 6) {
  console.error('Usage: sign-repair-installer.mjs REPAIR.py PUBLIC.pem PRIVATE.pem OUTPUT.sig');
  process.exit(2);
}
try {
  for (const path of [scriptPath, publicPath, privatePath]) {
    assert.ok(lstatSync(path).isFile(), 'Regular input required');
  }
  const script = readFileSync(scriptPath);
  const publicBody = readFileSync(publicPath);
  assert.equal(sha(script), SCRIPT);
  assert.equal(sha(publicBody), APPROVED);
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(publicBody);
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }));
  const message = Buffer.from(`GEOPS-B31-REPAIR-INSTALLER-SHA256\n${SCRIPT}\n`);
  const signature = sign(null, message, privateKey);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, message, publicKey, signature));
  writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ result: 'B31_REPAIR_INSTALLER_SIGNED',
    scriptSha256: SCRIPT, signatureSha256: sha(signature) }));
} catch (error) {
  console.error('B31 repair signing BLOCKED: ' + error.message);
  process.exitCode = 1;
}
