import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const target = fileURLToPath(new URL('../dist/db/migrations/', import.meta.url));
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
