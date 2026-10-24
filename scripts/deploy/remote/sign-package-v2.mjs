#!/usr/bin/env node
// Offline package signer. The installed v1 public key verifies this domain-separated digest.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [archivePath, keyPath, signaturePath] = process.argv.slice(2);
if (!archivePath || !keyPath || !signaturePath || process.argv.length !== 5)
  throw Error('Usage: sign-package-v2.mjs PACKAGE.tar.gz PRIVATE_KEY OUTPUT.sig');
const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 key required');
const message = Buffer.from(`GEOPS-V2-PACKAGE-SHA256\n${digest}\n`);
writeFileSync(signaturePath, sign(null, message, key), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ packageSha256: digest, signatureBytes: 64 }));
