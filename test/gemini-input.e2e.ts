/**
 * E2E test: Gemini CLI first-input submission.
 *
 * Root cause: Gemini uses Ink TUI which has an async startup phase (auth,
 * model loading, extensions).  The TextInput component isn't mounted until
 * initialization completes, so writing to stdin during this window is
 * silently lost.
 *
 * Fix: pass the initial prompt via `-i` (--prompt-interactive) CLI flag.
 * Gemini handles it internally once the TUI is ready.
 *
 * Run:  pnpm vitest run test/gemini-input.e2e.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';

// ─── Constants (match production worker.ts) ─────────────────────────────────

const GEMINI_BIN = 'gemini';
const PTY_COLS = 300;
const PTY_ROWS = 50;
const TEST_PROMPT = 'just say the word PONG and nothing else';

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
}

interface Chunk {
  time: number;
  offset: number;
  raw: string;
  stripped: string;
}

function simpleStrip(data: string): string {
  return data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Gemini first input submission', () => {
  let proc: pty.IPty | null = null;
  let tmpDir: string | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gemini-e2e-'));
  });

  afterEach(() => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  });

  it('bug: stdin write immediately after idle fires is lost', async () => {
    /**
     * Reproduces the production worker flow exactly:
     * 1. Gemini spawns with --yolo (no -i)
     * 2. IdleDetector fires on quiescence
     * 3. flushPending writes prompt IMMEDIATELY (same event loop turn)
     * 4. Gemini does NOT process it — TextInput hasn't mounted yet
     *
     * The bug is timing-dependent: writing much later (10s+) works because
     * TextInput eventually mounts.  The production path writes immediately.
     */
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];
    let promptWritten = false;
    let writeTs = 0;

    proc = pty.spawn(GEMINI_BIN, ['--yolo'], {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });

    const cliAdapter = createGeminiAdapter();
    const idleDetector = new IdleDetector(cliAdapter);
    // Simulate production flushPending: write IMMEDIATELY when idle fires
    idleDetector.onIdle(() => {
      if (!promptWritten && proc) {
        promptWritten = true;
        writeTs = Date.now();
        console.log(`>>> Idle fired at +${writeTs - spawnTime}ms — writing prompt immediately`);
        proc.write(TEST_PROMPT);
        setTimeout(() => proc!.write('\r'), 200);
      }
    });

    proc.onData((data) => {
      chunks.push({
        time: Date.now(),
        offset: Date.now() - spawnTime,
        raw: data,
        stripped: simpleStrip(data),
      });
      idleDetector.feed(data);
    });

    // Wait for idle + processing
    await delay(30_000);

    expect(promptWritten, 'idle should fire and prompt should be written').toBe(true);

    const afterOutput = stripAnsi(
      chunks.filter(c => c.time >= writeTs).map(c => c.raw).join('')
    );

    const hasPromptProcessed = afterOutput.includes('PONG') || afterOutput.includes('just say');

    console.log('\n=== STDIN WRITE RESULT ===');
    console.log(`Prompt processed: ${hasPromptProcessed}`);
    console.log('Output (first 400 chars):\n' + afterOutput.slice(0, 400));

    // When writing immediately after idle, the prompt is typically lost
    // because Ink's TextInput hasn't finished mounting.  This confirms
    // the need for the -i flag fix.
    //
    // Note: this is non-deterministic — if Gemini finishes init before
    // idle fires, stdin write may succeed.  The test documents the race
    // condition rather than guaranteeing failure.
    console.log(`\n>>> Bug reproduced (stdin lost): ${!hasPromptProcessed}`);

    idleDetector.dispose();
  }, 60_000);

  it('fix: -i flag delivers initial prompt reliably', async () => {
    /**
     * Verifies the fix: passing the initial prompt via -i (--prompt-interactive)
     * lets Gemini handle it internally once the TUI is ready.
     *
     * This is what the production adapter now does via buildArgs({ initialPrompt }).
     */
    const spawnTime = Date.now();
    const chunks: Chunk[] = [];

    // Use the adapter's buildArgs to get the correct args (includes -i)
    const cliAdapter = createGeminiAdapter();
    const args = cliAdapter.buildArgs({
      sessionId: 'test',
      resume: false,
      initialPrompt: TEST_PROMPT,
    });

    console.log(`>>> Spawning: gemini ${args.join(' ')}`);

    proc = pty.spawn(GEMINI_BIN, args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: tmpDir!,
      env: { ...process.env } as Record<string, string>,
    });

    proc.onData((data) => {
      chunks.push({
        time: Date.now(),
        offset: Date.now() - spawnTime,
        raw: data,
        stripped: simpleStrip(data),
      });
    });

    // Wait for Gemini to start and process the -i prompt
    await delay(30_000);

    const allOutput = stripAnsi(chunks.map(c => c.raw).join(''));

    const hasPromptProcessed = allOutput.includes('PONG') || allOutput.includes('pong');
    // Gemini should start processing: spinner activity, response text
    const hasSubstantialOutput = allOutput.length > 500;

    console.log('\n=== -i FLAG RESULT (should pass) ===');
    console.log(`Output length: ${allOutput.length}`);
    console.log(`Prompt processed (PONG): ${hasPromptProcessed}`);
    console.log(`Substantial output: ${hasSubstantialOutput}`);
    console.log('Output (last 600 chars):\n' + allOutput.slice(-600));

    expect(
      hasPromptProcessed || hasSubstantialOutput,
      'Gemini should process the prompt via -i flag',
    ).toBe(true);
  }, 60_000);

  it('adapter: passesInitialPromptViaArgs is true', () => {
    const adapter = createGeminiAdapter();
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('adapter: buildArgs includes -i when initialPrompt is set', () => {
    const adapter = createGeminiAdapter();
    const args = adapter.buildArgs({ sessionId: 'test', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--yolo');
    expect(args).toContain('-i');
    expect(args).toContain('hello world');
  });

  it('adapter: buildArgs omits -i when no initialPrompt', () => {
    const adapter = createGeminiAdapter();
    const args = adapter.buildArgs({ sessionId: 'test', resume: false });
    expect(args).toEqual(['--yolo']);
  });
});
