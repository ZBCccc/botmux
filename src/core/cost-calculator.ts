/**
 * Session cost calculator — computes token usage and estimated cost from JSONL logs.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  costUSD: number;
  turns: number;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

// Pricing per 1M tokens (USD) — Opus 4
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-6':           { input: 15, output: 75, cacheRead: 1.875, cacheCreate: 18.75 },
  'claude-opus-4-5-20251101':  { input: 15, output: 75, cacheRead: 1.875, cacheCreate: 18.75 },
  'claude-sonnet-4-5-20250929':{ input: 3,  output: 15, cacheRead: 0.30,  cacheCreate: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.8,output: 4,  cacheRead: 0.08,  cacheCreate: 1 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  const resolvedCwd = resolve(expandHome(cwd));
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = absolute path with / replaced by -
  const projectKey = resolvedCwd.replace(/\//g, '-');
  const jsonlPath = join(homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
}

export function getSessionCost(sessionId: string, cwd: string): SessionCost | null {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd);
  if (!jsonlPath) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheReadTokens += u.cache_read_input_tokens ?? 0;
        cacheCreateTokens += u.cache_creation_input_tokens ?? 0;
        if (msg.model && !model) model = msg.model;
        turns++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err: any) {
    logger.error(`Failed to read session JSONL: ${err.message}`);
    return null;
  }

  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['claude-opus-4-6'];
  const costUSD =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheCreateTokens / 1_000_000) * pricing.cacheCreate;

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, costUSD, turns };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
