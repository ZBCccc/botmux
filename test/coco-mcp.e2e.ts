/**
 * E2E test: CoCo MCP tool dispatch regression.
 *
 * Bug (CoCo 0.120.17, 2026-04-03 build):
 *   With the Test-O-New model, CoCo's tool-call pipeline normalises
 *     `mcp__<server>__<tool>`  →  `mcp-<server>-<tool>`
 *   when dispatching but never reverses the transform, so *every* MCP
 *   tool call fails with:
 *     Error: No such tool available: mcp-<server>-<tool>
 *
 *   Only Test-O-New is affected; gpt-5 / Doubao-Seed / deepseek-v3 all
 *   round-trip correctly.  The bug breaks botmux entirely because the
 *   model cannot call `send_to_thread`, so user messages get no reply.
 *
 *   Fixed in CoCo 0.120.21 (2026-04-16).
 *
 * This test guards against a future regression by driving a real
 * `coco --print` with the botmux PID marker in place and asserting that
 * the MCP dispatch does NOT produce the dash-prefix "No such tool" error.
 *
 * Run:  pnpm vitest run test/coco-mcp.e2e.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from '../src/adapters/cli/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DIST_INDEX = join(PROJECT_ROOT, 'dist', 'index.js');
const SESSION_DATA_DIR = join(PROJECT_ROOT, 'data');

// Signature of the CoCo 0.120.17 bug — `mcp__x__y` normalised to `mcp-x-y`
// and then unresolved.  Any occurrence means the dispatch is broken again.
const DASH_PREFIX_ERROR = /No such tool available:\s*mcp-\w+-/i;

/**
 * Run `coco --print` with a PID marker in place so the botmux MCP server
 * registers its tools (two-gate detection: BOTMUX=1 + ancestor marker).
 * Returns stdout+stderr combined.
 */
function runCocoPrint(prompt: string, timeoutMs = 120_000): string {
  const coco = resolveCommand('coco');
  const markersDir = join(SESSION_DATA_DIR, '.botmux-cli-pids');
  mkdirSync(markersDir, { recursive: true });

  // Write a marker keyed on the `coco` child's expected ppid — but we don't
  // know the child pid yet.  Instead, we use a wrapper shell that writes a
  // marker for its own PID (which becomes coco's parent), then execs coco.
  // This mirrors how the real worker writes the marker.
  const wrapper = `
    MARKER=${markersDir}/$$
    echo "coco-mcp-e2e-test" > "$MARKER"
    trap 'rm -f "$MARKER"' EXIT
    exec "${coco}" --print --yolo "$1"
  `;

  const result = spawnSync('bash', ['-c', wrapper, '_', prompt], {
    env: {
      ...process.env,
      BOTMUX: '1',
      SESSION_DATA_DIR,
      // LARK creds only matter if a tool actually calls Lark.  list_bots is
      // fine with bogus values; it just reads the bot registry file.
      LARK_APP_ID: process.env.LARK_APP_ID ?? 'test',
      LARK_APP_SECRET: process.env.LARK_APP_SECRET ?? 'test',
    },
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  return (result.stdout ?? '') + (result.stderr ?? '');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CoCo MCP tool dispatch', () => {
  it('prerequisite: dist/index.js is built', () => {
    expect(
      existsSync(DIST_INDEX),
      'run `pnpm build` before this test — CoCo spawns dist/index.js as the botmux MCP server',
    ).toBe(true);
  });

  it('regression: mcp__botmux__* tools do NOT fail with dash-prefix "No such tool" error', () => {
    // Ask CoCo to make exactly one call.  Instruction is explicit so we don't
    // depend on the model's reasoning about when to use the tool — we just
    // need the dispatch path to execute.
    const output = runCocoPrint(
      'Call the tool `mcp__botmux__list_bots` exactly once with no arguments. ' +
      'Then report the raw tool result or raw error verbatim. Do not retry.',
    );

    console.log('--- coco output (first 2000 chars) ---');
    console.log(output.slice(0, 2000));
    console.log('--- end ---');

    expect(
      DASH_PREFIX_ERROR.test(output),
      'CoCo 0.120.17-style regression detected — Test-O-New model path rewrites ' +
      '`mcp__server__tool` to `mcp-server-tool` and then fails dispatch. ' +
      'Either upgrade CoCo (fixed in 0.120.21) or switch model via `-c model.name=gpt-5`. ' +
      `Output: ${output.slice(0, 500)}`,
    ).toBe(false);
  }, 180_000);

  it('regression: other MCP servers also dispatch correctly (mcp__Codebase__GetMe)', () => {
    // A second server rules out the chance that botmux is hit by a different
    // bug (e.g. server name length) while the generic MCP dispatch is broken.
    // This will be skipped if Codebase MCP isn't configured in traecli.yaml.
    const output = runCocoPrint(
      'Call the tool `mcp__Codebase__GetMe` exactly once with no arguments. ' +
      'Report the raw tool result or raw error verbatim. Do not retry.',
    );

    console.log('--- coco output (first 1500 chars) ---');
    console.log(output.slice(0, 1500));
    console.log('--- end ---');

    const notConfigured = /not configured|not available|No MCP server/i.test(output)
      && !DASH_PREFIX_ERROR.test(output);
    if (notConfigured) {
      console.log('[skip] Codebase MCP not configured in traecli.yaml — skipping');
      return;
    }

    expect(
      DASH_PREFIX_ERROR.test(output),
      'Dash-prefix normalisation bug present on a non-botmux server too — ' +
      'this is the CoCo tool-dispatch regression, not a botmux issue. ' +
      `Output: ${output.slice(0, 500)}`,
    ).toBe(false);
  }, 180_000);
});
