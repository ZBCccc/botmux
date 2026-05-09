/**
 * Reader for CoCo's per-session events JSONL.
 *
 * CoCo stores each session under:
 *   ~/.cache/coco/sessions/<sessionId>/events.jsonl
 *
 * The bridge fallback only needs the original user prompt and the final
 * assistant message. Those appear as event objects containing
 * `message.message.role === "user" | "assistant"`. CoCo also writes
 * additional user-shaped system reminders; we intentionally keep only
 * user messages whose `extra.is_original_user_input === true` so a Lark
 * turn fingerprints against the user's prompt, not injected context.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COCO_SESSIONS_ROOT = join(homedir(), '.cache', 'coco', 'sessions');
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CocoBridgeEvent {
  /** Synthetic uuid for dedup: `<absPath>:<byteOffset>` of the line start. */
  uuid: string;
  /** Wall-clock ms parsed from `created_at`, falling back to Date.now(). */
  timestampMs: number;
  /** 'user' starts a pending Lark turn; 'assistant_final' closes it. */
  kind: 'user' | 'assistant_final';
  /** Message text. */
  text: string;
}

export interface CocoDrainResult {
  events: CocoBridgeEvent[];
  newOffset: number;
  pendingTail: string;
}

export function cocoEventsPathForSession(sessionId: string): string {
  return join(COCO_SESSIONS_ROOT, sessionId, 'events.jsonl');
}

/** Walk `/proc/<pid>/fd` to find which CoCo session a running CoCo process is
 *  bound to. Unlike Codex (which keeps its rollout fd open continuously),
 *  CoCo opens-writes-closes `events.jsonl` per event, so we look for ANY open
 *  file under the session dir — `session.log` and `traces.jsonl` are held
 *  open for the session's lifetime and reveal the same `<sid>` segment.
 *
 *  procfs may report `<path> (deleted)` for a previously-unlinked file kept
 *  alive by the open fd; strip that suffix before matching. Linux-only —
 *  returns undefined elsewhere or when /proc lookup fails. */
export function findCocoSessionByPid(
  pid: number,
): { sessionId: string; eventsPath: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'linux') return undefined;
  const fdDir = `/proc/${pid}/fd`;
  if (!existsSync(fdDir)) return undefined;
  let entries: string[];
  try { entries = readdirSync(fdDir); } catch { return undefined; }
  const prefix = COCO_SESSIONS_ROOT + '/';
  for (const fd of entries) {
    let target: string;
    try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
    const cleanTarget = target.replace(/ \(deleted\)$/, '');
    if (!cleanTarget.startsWith(prefix)) continue;
    const sid = cleanTarget.slice(prefix.length).split('/')[0];
    if (sid && SESSION_UUID_RE.test(sid)) {
      return { sessionId: sid, eventsPath: cocoEventsPathForSession(sid) };
    }
  }
  return undefined;
}

function messageText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

/** Increment-read a CoCo events.jsonl from `fromOffset`. */
export function drainCocoEvents(path: string, fromOffset: number): CocoDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CocoBridgeEvent[] = [];
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message?.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();

    if (msg.role === 'user') {
      if (msg.extra?.is_original_user_input !== true) continue;
      const content = messageText(msg.content);
      if (!content) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text: content });
    } else if (msg.role === 'assistant') {
      // CoCo emits two assistant shapes per turn:
      //   - finish_reason:'tool_calls' — mid-turn "thinking out loud" before
      //     a tool call. Sometimes carries visible text (e.g. "Let me run
      //     the tests..."). Treating these as final would close the
      //     pending Lark turn early with mid-turn narration; the actual
      //     `stop` message that follows would then drop on the floor
      //     because the queue's collecting slot is already cleared.
      //   - finish_reason:'stop' — the model's terminal answer. This is
      //     what the bridge fallback should forward.
      // Only the latter becomes assistant_final; everything else is skipped.
      const finishReason = msg.response_meta?.finish_reason;
      if (finishReason !== 'stop') continue;
      const content = messageText(msg.content);
      if (!content) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: content });
    }
  }

  return { events, newOffset, pendingTail };
}
