#!/usr/bin/env node
/** Exercises the API/Web containers that the lab controller actually promoted. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dir = resolve(process.argv[2] ?? '');
if (
  dirname(dir) !== join(root, 'artifacts') ||
  !/^b30-lab-[a-z0-9-]+$/.test(dir.split(/[\\/]/).at(-1))
)
  throw new Error('Isolated lab directory required');
const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const composeFile = join(root, 'infrastructure/compose/compose.b30-deployment-lab.yaml');
const prefix = ['compose', '-p', ctx.project, '-f', composeFile, '--env-file', join(dir, '.env')];
const docker = (args) =>
  execFileSync('docker', [...prefix, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
const observed = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'));
assert.equal(observed.phase, 'complete');
const portText = docker(['port', 'db', '5432']).trim();
const port = /127\.0\.0\.1:(\d+)$/.exec(portText)?.[1];
assert.ok(port);
const env = readFileSync(join(dir, '.env'), 'utf8');
const pass = /^GEOPS_LAB_DB_PASSWORD=(.+)$/m.exec(env)?.[1];
assert.match(pass, /^[a-f0-9]{64}$/);
const pool = new pg.Pool({
  connectionString: `postgres://postgres:${pass}@127.0.0.1:${port}/geops_dev`,
});
try {
  const hash = await argon2.hash('synthetic-b30-laboratory-password', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await pool.query('UPDATE admin_user SET password_hash=$1 WHERE id=$2', [hash, ctx.seed.admin]);
  for (const permission of [
    'visit.catalog.read',
    'visit.catalog.write',
    'visit.schedule.read',
    'visit.schedule.write',
    'visit.result.read',
    'visit.evidence.read',
    'visit.device.read',
    'gps.location.read',
    'gps.session.read',
    'gps.audit.read',
  ]) {
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3) ON CONFLICT DO NOTHING',
      [ctx.seed.admin, permission, 'Synthetic B30 container smoke'],
    );
  }
  await pool.query(
    "INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,'Synthetic B30 container smoke') ON CONFLICT DO NOTHING",
    [ctx.seed.admin],
  );
} finally {
  await pool.end();
}

const code = `const base='http://127.0.0.1:3500';
const origin='http://127.0.0.1:3501';
const login=await fetch(base+'/v1/admin/auth/sessions',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'b30-lab@example.invalid',password:'synthetic-b30-laboratory-password'})});
if(login.status!==200)throw Error('login '+login.status);
const session=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];
const headers={cookie};const checks=[];
async function check(path){const r=await fetch(base+path,{headers});checks.push([path,r.status]);if(r.status!==200)throw Error(path+' '+r.status);return r.json()}
await check('/health/ready');await check('/v1/admin/auth/me');
await check('/v1/admin/client-capabilities');await check('/v1/admin/clients');
await check('/v1/admin/routes');await check('/v1/admin/agents');
await check('/v1/admin/calendar?from=2026-10-26&to=2026-11-01');
await check('/v1/admin/compliance?from=2026-10-26&to=2026-11-01');
async function create(path,body){const r=await fetch(base+path,{method:'POST',headers:{...headers,origin,'x-csrf-token':session.csrf_token,'idempotency-key':crypto.randomUUID(),'content-type':'application/json'},body:JSON.stringify(body)});checks.push([path,r.status]);if(r.status!==201)throw Error(path+' '+r.status+' '+JSON.stringify(await r.json()));return r.json()}
const code=crypto.randomUUID().slice(0,8).toUpperCase();
const client=await create('/v1/admin/clients',{code:'C'+code,name:'Synthetic upgraded client',address:'Synthetic address',site:{code:'S'+code,name:'Synthetic site',address:'Synthetic address',latitude:14.63,longitude:-90.52}});
await check('/v1/admin/clients/'+client.id);
await create('/v1/admin/routes',{code:'R'+code,name:'Synthetic upgraded route'});
await create('/v1/admin/agents',{code:'A'+code,name:'Synthetic upgraded agent'});
const gps=await fetch(base+'/v2/device/gps/batches',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});checks.push(['GPS unauthenticated',gps.status]);if(gps.status!==401)throw Error('GPS auth boundary '+gps.status);
console.log(JSON.stringify({result:'B30_API_CONTAINER_PASS',checks}));`;
const api = docker(['exec', '-T', 'api', 'node', '--input-type=module', '-e', code]);
const web = docker(['exec', '-T', 'web', 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/']);
assert.match(web, /\/assets\//);
console.log(api.trim());
console.log(JSON.stringify({ result: 'B30_WEB_CONTAINER_PASS', assets: true }));
