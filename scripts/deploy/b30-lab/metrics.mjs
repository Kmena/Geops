#!/usr/bin/env node
/** Reads real phase timestamps and probes the promoted containers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dir = resolve(process.argv[2] ?? '');
if (
  dirname(dir) !== join(root, 'artifacts') ||
  !/^b30-lab-[a-z0-9-]+$/.test(dir.split(/[\\/]/).at(-1))
)
  throw new Error('Isolated lab directory required');
const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const start = (phase) => events.find((e) => e.phase === phase && e.lastCompleted !== phase);
const end = (phase) => events.find((e) => e.phase === 'pending' && e.lastCompleted === phase);
const ms = (a, b) => Date.parse(b.at) - Date.parse(a.at);
const first = start('preflight');
const complete = events.find((e) => e.phase === 'complete');
assert.ok(first && complete);
const phaseMs = Object.fromEntries(
  ['preflight', 'drain', 'backup', 'prepare', 'migrate', 'api', 'web', 'health'].map((phase) => [
    phase,
    start(phase) && end(phase) ? ms(start(phase), end(phase)) : null,
  ]),
);
const compose = join(root, 'infrastructure/compose/compose.b30-deployment-lab.yaml');
const code = `const n=10;const api=[];const web=[];
for(let i=0;i<n;i++){
 let t=performance.now();let r=await fetch('http://127.0.0.1:3500/health/ready');if(!r.ok)throw Error('API health');api.push(performance.now()-t);
 t=performance.now();r=await fetch('http://web:8080/health');if(!r.ok)throw Error('Web health');web.push(performance.now()-t)
}
console.log(JSON.stringify({apiMs:api,webMs:web}));`;
const output = execFileSync(
  'docker',
  [
    'compose',
    '-p',
    ctx.project,
    '-f',
    compose,
    '--env-file',
    join(dir, '.env'),
    'exec',
    '-T',
    'api',
    'node',
    '-e',
    code,
  ],
  { cwd: root, encoding: 'utf8', timeout: 120_000 },
);
const health = JSON.parse(output.trim());
const result = {
  result: 'B30_LAB_METRICS',
  project: ctx.project,
  totalMs: ms(first, complete),
  downtimeWindowMs: ms(start('drain'), complete),
  phaseMs,
  health,
  sampleCount: 10,
};
console.log(JSON.stringify(result));
