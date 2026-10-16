import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);
const sensitivePath =
  /(^|\/)(secrets(?:\.[^/]*)?|\.env(?:\.(?![^/]*\.example$)[^/]*)?|[^/]+\.(?:p12|pfx|jks|keystore|key))$/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const credentialLiteral =
  /(?:client_secret|refresh_token|access_token)\s*[:=]\s*['"][A-Za-z0-9_-]{30,}['"]/i;
let failures = 0;
for (const path of paths) {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.endsWith('.example')) continue;
  if (sensitivePath.test(normalized)) {
    process.stderr.write(`Sensitive path is eligible for Git: ${normalized}\n`);
    failures++;
    continue;
  }
  if (!statSync(path).isFile()) continue;
  const source = readFileSync(path);
  if (source.includes(0)) continue;
  const content = source.toString('utf8');
  if (privateKey.test(content) || credentialLiteral.test(content)) {
    process.stderr.write(`Potential secret in: ${normalized}\n`);
    failures++;
  }
}
if (failures) {
  process.stderr.write(`GEOPS secret scan failed: ${failures} candidate(s); values withheld\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `GEOPS secret scan: PASS, ${paths.length} eligible files inspected; values withheld\n`,
  );
}
