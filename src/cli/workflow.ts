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

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { EventLog } from '../workflows/events/append.js';
import { replay, type Snapshot } from '../workflows/events/replay.js';
import { parseWorkflowDefinition } from '../workflows/definition.js';
import { loadWorkflowDefinition } from '../workflows/loader.js';
import { runLoop } from '../workflows/loop.js';
import { mintWorkflowRunId } from '../workflows/run-id.js';
import { createRun, type BotResolver } from '../workflows/run-init.js';
import { getRunsDir, runDir } from '../workflows/runs-dir.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../workflows/hostExecutors/registry.js';
import { loadEffectInputSidecar } from '../workflows/effect-input.js';
import {
  completeNodeCancel,
  completeRunCancel,
  requestCancel,
} from '../workflows/cancel.js';
import {
  createStubSpawnFn,
  type StubSpawnHandler,
} from '../workflows/spawn-bot.js';
import type {
  WorkerSpawnFn,
  WorkflowRuntimeContext,
} from '../workflows/runtime.js';

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
    case 'resume':
      await cmdWorkflowResume(rest);
      return;
    case 'cancel':
      await cmdWorkflowCancel(rest);
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
  console.log(`用法: botmux workflow <run|resume|cancel|show> [...]

子命令:
  run <id> [--param key=value ...] [--run-id <id>] [--bot-resolver echo]
      离线驱动 workflow（stub spawn）。事件 / 状态打到 stdout。
      humanGate 节点跑到 'awaiting-wait' 即退出（CLI 离线场景下没有审批入口）。

  resume <runId>
      从磁盘 runDir 冷恢复一个已有 run。R0 recovery 先收 dangling effect，
      之后 orchestrator 继续推进；遇到 humanGate 只输出 awaiting-wait，
      不伪造审批；run 已 terminal 则直接打摘要，零事件写入。
      CLI 不会 spawn 新 subagent —— 现有 in-flight subagent 会被标记
      WorkerCrashed/manual 并由 orchestrator 终结 run。

  cancel <runId> [--reason <text>]
      写入 run-level cancelRequested 并驱动 cancel recovery。terminal run
      直接 no-op；不会发 IM 通知或重发审批卡。

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

  // Bootstrap the in-memory bot registry so hostExecutors like
  // feishu-send can resolve `larkAppId` → Lark client.  IM path inherits
  // the daemon's already-registered bots; the standalone CLI doesn't.
  try {
    const { registerBot, loadBotConfigs } = await import('../bot-registry.js');
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch {
    // Missing/invalid bots.json is fine — workflows that don't touch
    // Feishu still run; the host executor will surface a clear
    // "Bot not registered" error if one does.
  }

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
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
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

// ─── resume ───────────────────────────────────────────────────────────────

/**
 * R1 cold resume — pick up an existing run from its on-disk runDir.
 *
 * Contract (codex-loopy review 2026-05-20):
 *   - Replay first.  If the run is already terminal, print summary and
 *     write zero events.
 *   - Do NOT call `createRun` / write `runStarted` — those are mint-time
 *     events.  Resume just attaches a fresh ctx to the existing log.
 *   - `spawnSubagent` is a no-throw failure stub: returns
 *     `WorkerCrashed/manual` so any subagent dispatch the orchestrator
 *     decides to do during resume lands as a recorded `activityFailed`
 *     (NOT a thrown JS error that would crash the CLI).  manual class
 *     prevents R0 from auto-retrying.
 *   - hostExecutors / reconcilers / loadEffectInput are wired so the
 *     recovery phase can settle dangling side-effects via reconciler.
 *
 * Out of scope for R1: daemon-startup scan, watcher rebuild, real worker
 * reattach, dashboard surface.
 */
async function cmdWorkflowResume(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow resume <runId>');
    process.exit(1);
  }

  const runsDir = getRunsDir();
  const dir = runDir(runId, runsDir);
  const workflowJsonPath = join(dir, 'workflow.json');

  let defRaw: string;
  try {
    defRaw = await fs.readFile(workflowJsonPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`找不到 runDir 的 workflow.json：${workflowJsonPath}`);
      console.error(`(runsDir=${runsDir}；用 BOTMUX_WORKFLOW_RUNS_DIR 覆盖)`);
    } else {
      console.error(`读取 ${workflowJsonPath} 失败：${(err as Error).message}`);
    }
    process.exit(1);
  }

  let def;
  try {
    def = parseWorkflowDefinition(JSON.parse(defRaw!));
  } catch (err) {
    console.error(`解析 ${workflowJsonPath} 失败：${(err as Error).message}`);
    process.exit(1);
    return;
  }

  // Same as run: load bots so feishu host executors can resolve larkAppId.
  try {
    const { registerBot, loadBotConfigs } = await import('../bot-registry.js');
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch {
    // bots.json missing/invalid is fine — workflows that don't touch IM
    // still resume; IM-touching steps will surface a clear error.
  }

  const log = new EventLog(runId, runsDir);
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${runsDir})`);
    process.exit(1);
  }

  const { replay } = await import('../workflows/events/replay.js');
  const initialSnap = replay(events);

  console.log(`workflow=${def!.workflowId} runId=${runId}`);
  console.log(`runsDir=${runsDir}`);

  // ── Terminal short-circuit ────────────────────────────────────────────
  // Per codex review: replay first; if the run already finished, print
  // summary and DON'T enter runLoop (no new events written).
  if (
    initialSnap.run.status === 'succeeded' ||
    initialSnap.run.status === 'failed' ||
    initialSnap.run.status === 'cancelled'
  ) {
    console.log(`\nrun.status=${initialSnap.run.status} (terminal — nothing to resume)`);
    console.log(`events: ${initialSnap.lastSeq}`);
    if (initialSnap.run.output) {
      console.log(`output: ${initialSnap.run.output.outputHash}`);
    }
    if (initialSnap.run.status !== 'succeeded') {
      process.exit(1);
    }
    return;
  }

  const spawnSubagent: WorkerSpawnFn = async (input) => ({
    kind: 'failure',
    errorCode: 'WorkerCrashed',
    errorClass: 'manual',
    errorMessage:
      `subagent '${input.botName}' (node=${input.nodeId}, activity=${input.activityId}) ` +
      `is not resumable via 'botmux workflow resume' — CLI does not spawn workers. ` +
      `Use IM /workflow run for full execution, or restart the run.`,
  });

  const ctx: WorkflowRuntimeContext = {
    log,
    def: def!,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
  };

  const result = await runLoop(ctx, { maxTicks: 200 });

  console.log(`\nloop stopped: ${result.reason} after ${result.ticks} tick(s)`);
  console.log(`run.status=${result.lastSnapshot.run.status}`);
  console.log(`events: ${result.lastSnapshot.lastSeq}`);
  if (result.reason === 'awaiting-wait') {
    console.log(`awaiting-wait on: ${result.lastSnapshot.danglingWaits.join(', ')}`);
    console.log(`(CLI resume 不发卡；从 IM 用 /workflow run 进的话审批入口在那边)`);
  }
  if (result.reason === 'no-progress') {
    if (result.lastSnapshot.danglingEffectAttempted.length > 0) {
      console.log(
        `dangling effects: ${result.lastSnapshot.danglingEffectAttempted.join(', ')}`,
      );
    }
    const danglingNonEffect = result.lastSnapshot.danglingActivities.filter(
      (a) => !result.lastSnapshot.danglingEffectAttempted.includes(a),
    );
    if (danglingNonEffect.length > 0) {
      console.log(`dangling activities (non-effect): ${danglingNonEffect.join(', ')}`);
    }
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.output) {
    console.log(`output: ${result.lastSnapshot.run.output.outputHash}`);
  }

  // Non-zero exit when the run did not resolve to a clean terminal/awaiting.
  if (
    result.reason !== 'terminal' &&
    result.reason !== 'awaiting-wait'
  ) {
    process.exit(1);
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.status !== 'succeeded') {
    process.exit(1);
  }
}

// ─── cancel ───────────────────────────────────────────────────────────────

async function cmdWorkflowCancel(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow cancel <runId> [--reason <text>]');
    process.exit(1);
  }
  const reason = argValue(rest, '--reason') ?? 'cancelled via botmux workflow cancel';
  const runsDir = getRunsDir();
  const log = new EventLog(runId, runsDir);

  const def = await loadRunWorkflowDefinition(runId, runsDir);
  let snapshot = replay(await readExistingRunEvents(log, runsDir, runId));

  console.log(`workflow=${def.workflowId} runId=${runId}`);
  console.log(`runsDir=${runsDir}`);

  if (isTerminalRunStatus(snapshot.run.status)) {
    console.log(`\nrun.status=${snapshot.run.status} (terminal — nothing to cancel)`);
    console.log(`events: ${snapshot.lastSeq}`);
    return;
  }

  if (!snapshot.cancelledRunIntent) {
    const cancel = await requestCancel(
      log,
      {
        target: { kind: 'run', runId },
        reason,
        by: 'cli',
      },
      'human',
    );
    console.log(`cancelRequested: ${cancel.eventId}`);
  } else {
    console.log(`cancel already requested: ${snapshot.cancelledRunIntent.cancelOriginEventId}`);
  }

  snapshot = replay(await log.readAll());
  await finalizeRunCancelIfPossible(log, def, snapshot);

  const ctx = workflowCliRuntimeContext(log, def, cliResumeSpawnSubagent);
  const result = await runLoop(ctx, { maxTicks: 200 });

  snapshot = replay(await log.readAll());
  await finalizeRunCancelIfPossible(log, def, snapshot);
  snapshot = replay(await log.readAll());

  console.log(`\nloop stopped: ${result.reason} after ${result.ticks} tick(s)`);
  console.log(`run.status=${snapshot.run.status}`);
  console.log(`events: ${snapshot.lastSeq}`);
  if (snapshot.danglingCancels.length > 0) {
    console.log(`dangling cancels: ${snapshot.danglingCancels.join(', ')}`);
  }
  if (snapshot.danglingEffectAttempted.length > 0) {
    console.log(`dangling effects: ${snapshot.danglingEffectAttempted.join(', ')}`);
  }
  if (snapshot.danglingWaits.length > 0) {
    console.log(`dangling waits: ${snapshot.danglingWaits.join(', ')}`);
  }

  if (snapshot.run.status !== 'cancelled') {
    process.exit(1);
  }
}

function workflowCliRuntimeContext(
  log: EventLog,
  def: Awaited<ReturnType<typeof loadRunWorkflowDefinition>>,
  spawnSubagent: WorkerSpawnFn,
): WorkflowRuntimeContext {
  return {
    log,
    def,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
  };
}

const cliResumeSpawnSubagent: WorkerSpawnFn = async (input) => ({
  kind: 'failure',
  errorCode: 'WorkerCrashed',
  errorClass: 'manual',
  errorMessage:
    `subagent '${input.botName}' (node=${input.nodeId}, activity=${input.activityId}) ` +
    `is not resumable via 'botmux workflow resume' — CLI does not spawn workers. ` +
    `Use IM /workflow run for full execution, or restart the run.`,
});

async function loadRunWorkflowDefinition(
  runId: string,
  runsDir = getRunsDir(),
): Promise<Awaited<ReturnType<typeof loadWorkflowDefinition>>> {
  const workflowJsonPath = join(runDir(runId, runsDir), 'workflow.json');
  let defRaw: string;
  try {
    defRaw = await fs.readFile(workflowJsonPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`找不到 runDir 的 workflow.json：${workflowJsonPath}`);
      console.error(`(runsDir=${runsDir}；用 BOTMUX_WORKFLOW_RUNS_DIR 覆盖)`);
    } else {
      console.error(`读取 ${workflowJsonPath} 失败：${(err as Error).message}`);
    }
    process.exit(1);
  }

  try {
    return parseWorkflowDefinition(JSON.parse(defRaw!));
  } catch (err) {
    console.error(`解析 ${workflowJsonPath} 失败：${(err as Error).message}`);
    process.exit(1);
  }
}

async function readExistingRunEvents(
  log: EventLog,
  runsDir: string,
  runId: string,
) {
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${runsDir})`);
    process.exit(1);
  }
  return events;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

async function finalizeRunCancelIfPossible(
  log: EventLog,
  def: Awaited<ReturnType<typeof loadRunWorkflowDefinition>>,
  snapshot: Snapshot,
): Promise<void> {
  const intent = snapshot.cancelledRunIntent;
  if (!intent) return;

  for (const nodeId of Object.keys(def.nodes)) {
    const nodeStatus = snapshot.nodes.get(nodeId)?.status ?? 'idle';
    if (isTerminalNodeStatus(nodeStatus)) continue;
    const ownedActivities = [...snapshot.activities.values()].filter(
      (activity) => activity.ownerNodeId === nodeId,
    );
    const hasNonTerminalActivity = ownedActivities.some(
      (activity) => !isTerminalActivityStatus(activity.status),
    );
    if (hasNonTerminalActivity) continue;
    await completeNodeCancel(
      log,
      {
        nodeId,
        cancelOriginEventId: intent.cancelOriginEventId,
      },
      'scheduler',
    );
  }

  const afterNodes = replay(await log.readAll());
  if (!afterNodes.cancelledRunIntent) return;
  const allNodesTerminal = Object.keys(def.nodes).every((nodeId) =>
    isTerminalNodeStatus(afterNodes.nodes.get(nodeId)?.status ?? 'idle'),
  );
  if (!allNodesTerminal) return;

  await completeRunCancel(
    log,
    { cancelOriginEventId: afterNodes.cancelledRunIntent.cancelOriginEventId },
    'scheduler',
  );
}

function isTerminalNodeStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}

function isTerminalActivityStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'timedOut' ||
    status === 'cancelled'
  );
}

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
