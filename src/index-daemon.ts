#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

// Load .env BEFORE any other module reads process.env
// Try ~/.claude-code-robot/.env first (npm global install), then CWD/.env (dev)
const globalEnv = join(homedir(), '.claude-code-robot', '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

async function main() {
  // Dynamic import so config.ts reads env vars AFTER dotenv has loaded them
  const { startDaemon } = await import('./daemon.js');
  const { logger } = await import('./utils/logger.js');
  logger.info('Starting claude-code-robot daemon...');
  await startDaemon();
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
