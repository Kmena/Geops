#!/usr/bin/env node
/** Offline Ed25519 signer for a reviewed B30 lab package; never publishes. */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [archive, keyFile, signatureFile] = process.argv.slice(2);
if (!archive || !keyFile || !signatureFile || process.argv.length !== 5)
  throw Error('Usage: sign.mjs PACKAGE.tar.gz PRIVATE_KEY OUTPUT.sig');
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
const key = createPrivateKey(readFileSync(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 key required');
const signature = sign(null, Buffer.from(`GEOPS-B30-LAB-PACKAGE-SHA256\n${digest}\n`), key);
writeFileSync(signatureFile, signature, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ packageSha256: digest, signatureBytes: signature.length }));
