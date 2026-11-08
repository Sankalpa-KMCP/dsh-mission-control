/**
 * Mission Control server entry point.
 *
 * Usage: node --experimental-strip-types packages/server/src/main.ts
 */

import { loadConfigFromEnv } from './config.ts';
import { startMissionControlServer } from './index.ts';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const { handle } = await startMissionControlServer(config);

  console.log(`DSH Mission Control server listening on http://${config.host}:${handle.port}`);
  console.log(`  mode:        ${config.mode}`);
  console.log(`  database:    ${config.dbLocation}`);
  console.log(`  auth:        ${config.authToken ? 'bearer token required' : 'DISABLED (local development mode)'}`);
  console.log(`  static root: ${config.staticDir ?? '(no dashboard build configured)'}`);

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down Mission Control...');
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(err => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
