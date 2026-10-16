import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { checkReadiness } from './db/migration-manager.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const app = createApp({ readinessProbe: () => checkReadiness(pool), logLevel: config.logLevel });
  app.addHook('onClose', async () => pool.end());
  await app.listen({ host: config.host, port: config.port });
}

main().catch(() => {
  process.stderr.write('GEOPS API startup failed; details withheld\n');
  process.exitCode = 1;
});
