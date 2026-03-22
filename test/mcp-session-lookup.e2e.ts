/**
 * E2E test: MCP server session lookup with per-bot session files.
 *
 * Reproduces the issue where MCP server (spawned by CLI as a child process)
 * cannot find sessions stored in per-bot files (sessions-{appId}.json).
 *
 * The test spawns the actual MCP server as a child process — the same way
 * CLI tools (Claude Code, Aiden, etc.) do — and sends tool calls via MCP
 * stdio protocol to verify session lookup works.
 *
 * Run:  pnpm vitest run test/mcp-session-lookup.e2e.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const MCP_SERVER_SCRIPT = join(PROJECT_ROOT, 'dist', 'index.js');

const TEST_APP_ID = 'cli_test_app_123';
const TEST_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEST_SESSION = {
  sessionId: TEST_SESSION_ID,
  chatId: 'oc_test_chat',
  rootMessageId: 'om_test_root',
  title: 'test session',
  status: 'active' as const,
  createdAt: new Date().toISOString(),
  larkAppId: TEST_APP_ID,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Send a JSON-RPC request via MCP stdio protocol and read the response. */
function mcpRequest(proc: ChildProcess, method: string, params: any, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 5000);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // MCP stdio uses newline-delimited JSON
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timeout);
            proc.stdout!.off('data', onData);
            resolve(msg);
          }
        } catch { /* partial line, wait for more */ }
      }
      // Keep the last partial line in buffer
      buffer = lines[lines.length - 1];
    };

    proc.stdout!.on('data', onData);

    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    proc.stdin!.write(request + '\n');
  });
}

/** Start MCP server as a child process with given env. */
function startMcpServer(env: Record<string, string>): ChildProcess {
  const proc = spawn('node', [MCP_SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  return proc;
}

/** Send MCP initialize handshake. */
async function mcpInitialize(proc: ChildProcess): Promise<void> {
  await mcpRequest(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  }, 0);
  // Send initialized notification
  proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

/** Call send_to_thread tool via MCP and return the result text. */
async function callGetThreadMessages(proc: ChildProcess, sessionId: string): Promise<any> {
  const resp = await mcpRequest(proc, 'tools/call', {
    name: 'get_thread_messages',
    arguments: { session_id: sessionId, limit: 1 },
  }, 1);
  const text = resp?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : resp;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP server session lookup with per-bot session files', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'botmux-mcp-test-'));
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('session in per-bot file, LARK_APP_ID set → finds via scoped file', async () => {
    // Daemon writes session to per-bot file
    writeFileSync(
      join(tmpDataDir, `sessions-${TEST_APP_ID}.json`),
      JSON.stringify({ [TEST_SESSION_ID]: TEST_SESSION }, null, 2),
    );

    const proc = startMcpServer({
      SESSION_DATA_DIR: tmpDataDir,
      LARK_APP_ID: TEST_APP_ID,
    });

    try {
      await mcpInitialize(proc);
      const result = await callGetThreadMessages(proc, TEST_SESSION_ID);
      // Session IS found (error is about Lark API, not "not found")
      expect(result.error ?? '').not.toContain('not found');
    } finally {
      proc.kill();
    }
  });

  it('session in per-bot file, NO LARK_APP_ID → finds via cross-file fallback', async () => {
    // Root cause scenario: MCP server spawned from a non-botmux CLI instance
    // (e.g. user's manual Claude Code session in default tmux session "0").
    // No LARK_APP_ID → session store reads sessions.json (empty) → miss.
    // The cross-file fallback should scan sessions-{appId}.json and find it.
    writeFileSync(
      join(tmpDataDir, `sessions-${TEST_APP_ID}.json`),
      JSON.stringify({ [TEST_SESSION_ID]: TEST_SESSION }, null, 2),
    );

    const proc = startMcpServer({
      SESSION_DATA_DIR: tmpDataDir,
      // NO LARK_APP_ID — simulates non-botmux CLI context
    });

    try {
      await mcpInitialize(proc);
      const result = await callGetThreadMessages(proc, TEST_SESSION_ID);
      console.log('No LARK_APP_ID, cross-file fallback:', JSON.stringify(result));

      // With the fallback fix, session should be found (error would be Lark API, not "not found")
      expect(result.error ?? '').not.toContain('not found');
    } finally {
      proc.kill();
    }
  });
});
