import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function parse(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1)
    throw new Error('Command after -- is required');
  const options = {};
  for (let i = 0; i < separator; i += 2) {
    if (!['--log', '--step', '--timeout-ms'].includes(argv[i]) || !argv[i + 1])
      throw new Error('Invalid timing option');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.log || !/^[a-z][a-z0-9_-]{1,50}$/.test(options.step ?? ''))
    throw new Error('Log path and safe step name required');
  const timeout = Number(options['timeout-ms']);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3_600_000)
    throw new Error('Timeout must be 1000–3600000 ms');
  return { log: options.log, step: options.step, timeout, command: argv.slice(separator + 1) };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  let timedOut = false;
  const child = spawn(options.command[0], options.command.slice(1), {
    shell: false,
    stdio: 'inherit',
  });
  let forceTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  }, options.timeout);
  const result = await new Promise((done) => {
    child.once('error', (error) =>
      done({ code: null, signal: null, error: error.code ?? 'SPAWN_ERROR' }),
    );
    child.once('exit', (code, signal) => done({ code, signal, error: null }));
  });
  clearTimeout(timer);
  clearTimeout(forceTimer);
  const record = {
    stage: options.step,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    error: result.error,
  };
  appendFileSync(options.log, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(record));
  process.exitCode = timedOut ? 124 : (result.code ?? 1);
}

main().catch((error) => {
  console.error(`Timing BLOCKED: ${error.message}`);
  process.exitCode = 1;
});
