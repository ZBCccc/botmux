/**
 * `botmux workflow <sub>` CLI subcommand handlers.
 *
 * v0 offline-runner: load a workflow definition, drive `runLoop` against
 * a stub spawn, and print events to stdout.  No daemon / no IM
 * integration — used for smoke-testing the orchestrator end-to-end.
 *
 * The on-daemon path (with lark fan-out, real worker spawn) lives in
 * the `/workflow run` Skill (Slice E-2).  This module deliberately
 * keeps the CLI route the simplest possible smoke test.
 */

import { EventLog } from '../workflows/events/append.js';
import { parseWorkflowDefinition } from '../workflows/definition.js';
import { loadWorkflowDefinition } from '../workflows/loader.js';
import { runLoop } from '../workflows/loop.js';
import { mintWorkflowRunId } from '../workflows/run-id.js';
import { createRun, type BotResolver } from '../workflows/run-init.js';
import { getRunsDir } from '../workflows/runs-dir.js';
import { createDefaultHostExecutorRegistry } from '../workflows/hostExecutors/registry.js';
import {
  createStubSpawnFn,
  type StubSpawnHandler,
} from '../workflows/spawn-bot.js';
import type { WorkflowRuntimeContext } from '../workflows/runtime.js';

// Local arg parsers — mirror cli.ts shape; deliberately not exported.
function argValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const f of flags) {
      if (a === f && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=') && i + 1 < args.length) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function cmdWorkflow(sub: string, rest: string[]): Promise<void> {
  switch (sub) {
    case 'run':
      await cmdWorkflowRun(rest);
      return;
    case 'show':
      await cmdWorkflowShow(rest);
      return;
    case 'help':
    case '':
    case undefined:
      printHelp();
      return;
    default:
      console.error(`未知子命令: workflow ${sub}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`用法: botmux workflow <run|show> [...]

子命令:
  run <id> [--param key=value ...] [--run-id <id>] [--bot-resolver echo]
      离线驱动 workflow（stub spawn）。事件 / 状态打到 stdout。
      humanGate 节点跑到 'awaiting-wait' 即退出（CLI 离线场景下没有审批入口）。

  show <runId>
      replay 当前 run 的事件，打印 Snapshot 摘要。

环境变量:
  BOTMUX_WORKFLOW_RUNS_DIR=<path>  覆盖 runs 根目录（默认 ~/.botmux/workflow-runs）
`);
}

// ─── run ──────────────────────────────────────────────────────────────────

async function cmdWorkflowRun(rest: string[]): Promise<void> {
  const id = positionals(rest)[0];
  if (!id) {
    console.error('用法: botmux workflow run <id> [--param key=value ...]');
    process.exit(1);
  }
  const runId = argValue(rest, '--run-id') ?? mintWorkflowRunId(id);
  const params = collectParams(rest);

  const def = await loadWorkflowDefinition(id).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
  // unreachable after process.exit, but TS doesn't know
  if (!def) return;
  validateParams(def, params);

  const log = new EventLog(runId, getRunsDir());
  const botResolver: BotResolver = () => ({});
  const spawnSubagent = createStubSpawnFn(echoHandler);

  console.log(`workflow=${id} runId=${runId} params=${JSON.stringify(params)}`);
  console.log(`runsDir=${getRunsDir()}`);

  await createRun(log, { def, params, initiator: 'cli', botResolver });
  console.log('runCreated, runStarted');

  const ctx: WorkflowRuntimeContext = {
    log,
    def,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
  };
  const result = await runLoop(ctx, { maxTicks: 200 });

  console.log(`\nloop stopped: ${result.reason} after ${result.ticks} tick(s)`);
  console.log(`run.status=${result.lastSnapshot.run.status}`);
  console.log(`events: ${result.lastSnapshot.lastSeq}`);
  if (result.reason === 'awaiting-wait') {
    console.log(`awaiting-wait on: ${result.lastSnapshot.danglingWaits.join(', ')}`);
    console.log(`(CLI 离线模式没有审批入口；从 IM 用 /workflow run 跑能拿到审批卡)`);
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.output) {
    console.log(`output: ${result.lastSnapshot.run.output.outputHash}`);
  }
}

const echoHandler: StubSpawnHandler = (input) => ({
  echo: input.prompt.slice(0, 200),
  bot: input.botName,
  activityId: input.activityId,
});

function collectParams(rest: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--param' && i + 1 < rest.length) {
      const kv = rest[i + 1]!;
      const eq = kv.indexOf('=');
      if (eq <= 0) {
        console.error(`--param 期望 key=value，收到 "${kv}"`);
        process.exit(1);
      }
      const key = kv.slice(0, eq);
      const raw = kv.slice(eq + 1);
      out[key] = coerce(raw);
      i++;
    } else if (rest[i]?.startsWith('--param=')) {
      const kv = rest[i]!.slice('--param='.length);
      const eq = kv.indexOf('=');
      if (eq <= 0) {
        console.error(`--param 期望 key=value，收到 "${kv}"`);
        process.exit(1);
      }
      out[kv.slice(0, eq)] = coerce(kv.slice(eq + 1));
    }
  }
  return out;
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function validateParams(
  def: Awaited<ReturnType<typeof loadWorkflowDefinition>>,
  params: Record<string, unknown>,
): void {
  if (!def.params) return;
  for (const [name, spec] of Object.entries(def.params)) {
    if (spec.required && !(name in params)) {
      console.error(`缺少必填 param: ${name} (type=${spec.type})`);
      process.exit(1);
    }
  }
}

// ─── show ─────────────────────────────────────────────────────────────────

async function cmdWorkflowShow(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow show <runId>');
    process.exit(1);
  }
  const { replay } = await import('../workflows/events/replay.js');
  const log = new EventLog(runId, getRunsDir());
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${getRunsDir()})`);
    process.exit(1);
  }
  const snap = replay(events);
  console.log(JSON.stringify(
    {
      runId,
      workflowId: snap.run.workflowId,
      revisionId: snap.run.revisionId,
      status: snap.run.status,
      lastSeq: snap.lastSeq,
      nodes: [...snap.nodes.entries()].map(([id, n]) => ({
        id,
        status: n.status,
        retryCount: n.retryCount,
      })),
      danglingActivities: snap.danglingActivities,
      danglingWaits: snap.danglingWaits,
    },
    null,
    2,
  ));
  // `parseWorkflowDefinition` re-exported here only so the bundler keeps it
  // alongside loader (some smoke tests dlopen the helpers directly).
  void parseWorkflowDefinition;
}
