#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

// Legacy: load .env for global settings (WEB_HOST, WEB_EXTERNAL_HOST, etc.)
// Bot config now lives in bots.json; this is kept for backward compatibility.
const globalEnv = join(homedir(), '.botmux', '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

async function main() {
  // Dynamic import so config.ts reads env vars AFTER dotenv has loaded them
  const { startDaemon } = await import('./daemon.js');
  const { logger } = await import('./utils/logger.js');
  logger.info('Starting botmux daemon...');
  await startDaemon();
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
