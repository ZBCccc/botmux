/**
 * E2E test: Claude Code MCP auto-installation.
 *
 * Validates that ensureMcpConfig() correctly writes and UPDATES
 * the MCP server entry in ~/.claude.json, including env changes.
 *
 * Bug: ensureMcpConfig only checks args[0] to decide whether to skip —
 *      so env changes (e.g. adding SESSION_DATA_DIR) are never written.
 *
 * Run:  pnpm test:claude-mcp
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DIST_INDEX = join(PROJECT_ROOT, 'dist', 'index.js');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const CLAUDE_JSON = join(homedir(), '.claude.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readClaudeJson(): any {
  if (!existsSync(CLAUDE_JSON)) return {};
  return JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
}

function getMcpEntry(): any {
  return readClaudeJson().mcpServers?.['botmux'];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Claude Code MCP auto-installation', () => {
  let backupPath: string;

  beforeEach(() => {
    // Back up the real ~/.claude.json so we can restore it after each test
    backupPath = join(mkdtempSync(join(tmpdir(), 'claude-json-backup-')), 'claude.json');
    if (existsSync(CLAUDE_JSON)) {
      copyFileSync(CLAUDE_JSON, backupPath);
    }
  });

  afterEach(() => {
    // Restore original ~/.claude.json
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, CLAUDE_JSON);
    }
    try { rmSync(join(backupPath, '..'), { recursive: true, force: true }); } catch {}
  });

  it('fresh install: writes MCP entry with all env vars', () => {
    // Remove existing entry
    const data = readClaudeJson();
    if (data.mcpServers) delete data.mcpServers['botmux'];
    writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n');

    const adapter = createClaudeCodeAdapter();
    adapter.ensureMcpConfig({
      name: 'botmux',
      command: 'node',
      args: [DIST_INDEX],
      env: {
        LARK_APP_ID: 'test-app-id',
        LARK_APP_SECRET: 'test-app-secret',
        SESSION_DATA_DIR: '/tmp/test-data-dir',
      },
    });

    const entry = getMcpEntry();
    expect(entry).toBeDefined();
    expect(entry.command).toBe('node');
    expect(entry.args[0]).toContain('index.js');
    expect(entry.env.LARK_APP_ID).toBe('test-app-id');
    expect(entry.env.LARK_APP_SECRET).toBe('test-app-secret');
    expect(entry.env.SESSION_DATA_DIR).toBe('/tmp/test-data-dir');
  });

  it('bug: env changes are NOT picked up when args[0] is unchanged', () => {
    /**
     * Reproduces the production bug: ensureMcpConfig skips if args[0] matches,
     * even when env has changed (e.g. SESSION_DATA_DIR was added to worker-pool).
     *
     * This means old config entries missing SESSION_DATA_DIR never get updated.
     */
    // Seed with old config (no SESSION_DATA_DIR)
    const data = readClaudeJson();
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers['botmux'] = {
      command: 'node',
      args: [DIST_INDEX],
      env: {
        LARK_APP_ID: 'old-app-id',
        LARK_APP_SECRET: 'old-secret',
        // SESSION_DATA_DIR intentionally missing — this is the stale config
      },
    };
    writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n');

    // Now call ensureMcpConfig with updated env (includes SESSION_DATA_DIR)
    const adapter = createClaudeCodeAdapter();
    adapter.ensureMcpConfig({
      name: 'botmux',
      command: 'node',
      args: [DIST_INDEX],
      env: {
        LARK_APP_ID: 'new-app-id',
        LARK_APP_SECRET: 'new-secret',
        SESSION_DATA_DIR: '/tmp/new-data-dir',
      },
    });

    const entry = getMcpEntry();

    // With the current buggy code, entry still has old values:
    // The skip condition `existing.args?.[0] === entry.args[0]` returns true
    // because the script path hasn't changed, so the update is skipped.
    //
    // After fix, these should all reflect the new values:
    expect(entry.env.SESSION_DATA_DIR, 'SESSION_DATA_DIR must be written').toBe('/tmp/new-data-dir');
    expect(entry.env.LARK_APP_ID, 'LARK_APP_ID must be updated').toBe('new-app-id');
    expect(entry.env.LARK_APP_SECRET, 'LARK_APP_SECRET must be updated').toBe('new-secret');
  });

  it('production: ensureMcpConfig updates stale ~/.claude.json with SESSION_DATA_DIR', () => {
    /**
     * Simulates what the daemon does on first forkWorker(): calls
     * ensureMcpConfig with the full env including SESSION_DATA_DIR.
     *
     * If ~/.claude.json already has an entry without SESSION_DATA_DIR
     * (the stale production config), it must be updated.
     */
    const before = getMcpEntry();
    console.log('Before:', JSON.stringify(before, null, 2));

    const adapter = createClaudeCodeAdapter();
    adapter.ensureMcpConfig({
      name: 'botmux',
      command: 'node',
      args: [DIST_INDEX],
      env: {
        LARK_APP_ID: before?.env?.LARK_APP_ID ?? 'test',
        LARK_APP_SECRET: before?.env?.LARK_APP_SECRET ?? 'test',
        SESSION_DATA_DIR: DATA_DIR,
      },
    });

    const after = getMcpEntry();
    console.log('After:', JSON.stringify(after, null, 2));

    expect(after, 'botmux MCP entry must exist').toBeDefined();
    expect(after.env.SESSION_DATA_DIR, 'SESSION_DATA_DIR must be set').toBe(DATA_DIR);
    expect(after.env.LARK_APP_ID, 'LARK_APP_ID preserved').toBeTruthy();
    expect(after.env.LARK_APP_SECRET, 'LARK_APP_SECRET preserved').toBeTruthy();
  });
});
