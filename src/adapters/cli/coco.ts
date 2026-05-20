import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Global submit log — CoCo appends one JSON line here on every successful
 *  user submit across all sessions (mode:"user"). Format observed:
 *  `{"content":"...","mode":"user","timestamp":"..."}`. Used the same way
 *  the Codex adapter uses ~/.codex/history.jsonl: write → poll for our
 *  marker → retry Enter if missing → return {submitted:false, recheck}
 *  on final failure so worker can surface a Lark warning. */
const HISTORY_PATH = platform() === 'darwin'
  ? join(homedir(), 'Library', 'Caches', 'coco', 'history.jsonl')
  : join(homedir(), '.cache', 'coco', 'history.jsonl');

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

/** Scan `path` for a JSON line newer than `fromByte` that's a user-submit
 *  whose decoded `content` starts with `prefix`. Parses each candidate line
 *  with JSON.parse — substring match on the raw bytes is unreliable here
 *  because CoCo's Go marshaller HTML-escapes `<`, `>`, `&` into `<`,
 *  `>`, `&`, which our string-form prefix won't match. Decoding
 *  the field and comparing JS strings sidesteps all of that. */
function historyDeltaContains(path: string, fromByte: number, prefix: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const delta = buf.toString('utf8');
  for (const line of delta.split('\n')) {
    if (!line || !line.includes('"mode":"user"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.content === 'string' && parsed.content.startsWith(prefix)) {
        return true;
      }
    } catch {
      // Truncated tail / non-JSON line — keep scanning the rest.
    }
  }
  return false;
}

async function waitForHistoryAppend(
  path: string, fromByte: number, prefix: string, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (historyDeltaContains(path, fromByte, prefix)) return true;
    await delay(100);
  }
  return false;
}

/** First 40 chars of the original content — used as a prefix match against
 *  the JSON-decoded `content` field of each user-mode line in history.jsonl.
 *  Compare against decoded strings, NOT against raw file bytes: CoCo's Go
 *  marshaller HTML-escapes `<`, `>`, `&` so a JSON-encoded marker wouldn't
 *  match the stored bytes. 40 chars is unique enough across concurrent bots. */
function submitPrefix(content: string): string {
  return content.slice(0, 40);
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // CoCo / Trae CLI is a Claude Code fork (Ink TUI) with two failure modes
      // for multi-line input:
      //   1. tmux `send-keys -l` treats each \n as Enter — multi-line content
      //      either submits line-by-line or paste-burst-coalesces with the
      //      trailing Enter consumed as part of the paste (text stays stuck
      //      in the input box, never submitted).
      //   2. The old adapter had no verification, so the worker never knew
      //      and the user stared at Lark waiting for a reply that never came.
      //
      // Fix: use tmux `load-buffer` + `paste-buffer -d` (the `pasteText` path)
      // which automatically wraps the content in bracketed-paste markers
      // (`\e[200~...\e[201~`) when the Ink TUI has bracketed paste enabled —
      // Ink does by default on fresh spawn. CoCo sees an explicit START/END
      // pair, so embedded `\n` stay as content (no per-line submits) and the
      // trailing Enter after submitDelay is unambiguously a submit (not part
      // of an "ongoing paste burst" the way send-keys -l rapid input was).
      //
      // Why not send-keys -l + `\` + Enter soft-newlines (the claude-code
      // pattern): on Trae CLI 0.120.31 (May 2026 build), fresh-spawned CoCo
      // treats the rapid send-keys sequence as an open-ended paste burst and
      // swallows the final Enter as a soft-newline — message stranded in the
      // input box with no submit, no error. Manually pressing Enter 30 min
      // later still works (burst window times out eventually), so the issue
      // is "burst never terminates from CoCo's POV", which an explicit
      // bracketed-paste END marker fixes. claude-code.ts keeps its
      // send-keys-typing path because Claude Code can toggle bracketed paste
      // OFF after slash commands; CoCo on a fresh-spawn message doesn't have
      // that concern.
      //
      // Verification (unchanged): poll CoCo's platform-specific history.jsonl for the
      // user-submit line whose decoded `content` starts with our prefix.
      // Retry Enter up to 3 times, then return {submitted:false, recheck}
      // for the worker's deferred recheck + Lark warning path.
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session is gone (CLI exited mid-write) — bail cleanly
          // rather than crashing the worker on unhandled execFileSync.
          return false;
        }
      };

      const baseByte = currentFileSize(HISTORY_PATH);
      const prefix = submitPrefix(content);

      try {
        if (pty.pasteText) {
          // tmux mode: load-buffer + paste-buffer -d. Tmux wraps in bracketed
          // paste automatically when the pane has it on (Ink default). The
          // trailing `-d` deletes the buffer after pasting so it doesn't
          // accumulate across writes.
          pty.pasteText(content);
        } else {
          // Non-tmux fallback (raw PTY): wrap markers ourselves.
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }
      await delay(submitDelay);
      if (!trySendEnter()) return { submitted: false };

      // Fresh-install short-wait: when history.jsonl is absent at submit
      // time, give CoCo up to 1.2s to create it. If our marker shows up →
      // success. If the file is still absent → trust the Enter and return
      // (this is the genuine "first run / coco doesn't write history"
      // case). If the file appeared but our marker isn't there → fall
      // through to the normal retry/failure loop — better to warn than to
      // silently mask a real submit failure on a new install.
      if (!existsSync(HISTORY_PATH) && baseByte === 0) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 1200)) {
          return undefined;
        }
        if (!existsSync(HISTORY_PATH)) {
          return undefined;
        }
        // File appeared during the wait but our marker isn't in it — fall
        // through to the retry loop. baseByte stays 0 so the loop scans
        // the whole file.
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800)) {
          return undefined;
        }
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800)) {
        return undefined;
      }
      // In-band budget exhausted. Hand the worker a recheck closure: a slow
      // CoCo (cold start, large initial prompt, heavy hooks) may still
      // append our marker after retries gave up. Worker re-scans after a
      // delay before deciding whether to warn the user.
      const recheck = (): boolean => historyDeltaContains(HISTORY_PATH, baseByte, prefix);
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
