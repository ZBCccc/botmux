import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  requestCancel,
  deliverCancel,
  completeActivityCancel,
} from '../src/workflows/cancel.js';

const RUN_ID = 'run-cancel-test-01';
const SHA = 'sha256:' + 'f'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 24,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-cancel-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const runCreated: EventDraft = {
  runId: RUN_ID,
  type: 'runCreated',
  actor: 'scheduler',
  payload: {
    workflowId: 'wf-demo',
    revisionId: 'rev-001',
    inputRef: sampleOutputRef,
    initiator: 'tester',
  },
};

function attemptCreated(activityId: string, attemptId: string, nodeId = 'n-1'): EventDraft {
  return {
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      attemptNumber: 1,
      nodeId,
      inputRef: sampleOutputRef,
    },
  };
}

async function bootstrap(activityId: string, attemptId: string): Promise<void> {
  await log.append(runCreated);
  await log.append(attemptCreated(activityId, attemptId));
}

// ─── requestCancel ─────────────────────────────────────────────────────────

describe('cancel — requestCancel', () => {
  it('writes cancelRequested with kind=activity target', async () => {
    await bootstrap('a-1', 'at-1');
    const e = await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'user clicked stop',
      by: 'ou_alice',
    });
    expect(e.type).toBe('cancelRequested');
    expect(e.actor).toBe('human'); // default
    const p = e.payload as { target: { kind: string; activityId: string }; reason: string; by: string };
    expect(p.target).toEqual({ kind: 'activity', activityId: 'a-1' });
    expect(p.reason).toBe('user clicked stop');
    expect(p.by).toBe('ou_alice');
  });

  it('writes cancelRequested with kind=node target', async () => {
    await bootstrap('a-1', 'at-1');
    const e = await requestCancel(log, {
      target: { kind: 'node', nodeId: 'n-7' },
      reason: 'node-level abort',
      by: 'supervisor',
    }, 'supervisor');
    expect(e.actor).toBe('supervisor');
    const p = e.payload as { target: { kind: string; nodeId: string } };
    expect(p.target).toEqual({ kind: 'node', nodeId: 'n-7' });
  });

  it('writes cancelRequested with kind=run target', async () => {
    await bootstrap('a-1', 'at-1');
    const e = await requestCancel(log, {
      target: { kind: 'run', runId: RUN_ID },
      reason: 'run aborted',
      by: 'system',
    }, 'system');
    expect(e.actor).toBe('system');
    const p = e.payload as { target: { kind: string; runId: string } };
    expect(p.target).toEqual({ kind: 'run', runId: RUN_ID });
  });

  it('replay projects activity-target cancelRequested onto AttemptState.cancelRequest', async () => {
    await bootstrap('a-1', 'at-1');
    const req = await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'user clicked stop',
      by: 'ou_alice',
    });
    const snap = replay(await log.readAll());
    const at = snap.activities.get('a-1')?.attempts[0];
    expect(at?.cancelRequest).toMatchObject({
      cancelOriginEventId: req.eventId,
      requestedBy: 'ou_alice',
      reason: 'user clicked stop',
      delivered: false,
    });
    expect(snap.danglingCancels).toContain('a-1');
  });

  it('replay fans out node-target cancel onto activities under that node (Step 10)', async () => {
    await bootstrap('a-1', 'at-1');
    const req = await requestCancel(log, {
      target: { kind: 'node', nodeId: 'n-1' },
      reason: 'node abort',
      by: 'sys',
    });
    const snap = replay(await log.readAll());
    const cr = snap.activities.get('a-1')?.attempts[0].cancelRequest;
    expect(cr).toMatchObject({
      cancelOriginEventId: req.eventId,
      requestedBy: 'sys',
      reason: 'node abort',
      delivered: false,
    });
    expect(snap.danglingCancels).toContain('a-1');
  });

  it('replay fan-out skips activities under a DIFFERENT node', async () => {
    // Two activities on different nodes; cancel target = n-1, only a-1
    // should be marked.
    await log.append(runCreated);
    await log.append(attemptCreated('a-1', 'at-1', 'n-1'));
    await log.append(attemptCreated('a-2', 'at-2', 'n-2'));
    await requestCancel(log, {
      target: { kind: 'node', nodeId: 'n-1' },
      reason: 'r',
      by: 'b',
    });
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.attempts[0].cancelRequest).toBeDefined();
    expect(snap.activities.get('a-2')?.attempts[0].cancelRequest).toBeUndefined();
    expect(snap.danglingCancels).toEqual(['a-1']);
  });

  it('replay fans out run-target cancel onto ALL active activities', async () => {
    await log.append(runCreated);
    await log.append(attemptCreated('a-1', 'at-1', 'n-1'));
    await log.append(attemptCreated('a-2', 'at-2', 'n-2'));
    await log.append(attemptCreated('a-3', 'at-3', 'n-3'));
    const req = await requestCancel(log, {
      target: { kind: 'run', runId: RUN_ID },
      reason: 'kill it all',
      by: 'sys',
    });
    const snap = replay(await log.readAll());
    for (const id of ['a-1', 'a-2', 'a-3']) {
      const cr = snap.activities.get(id)?.attempts[0].cancelRequest;
      expect(cr?.cancelOriginEventId).toBe(req.eventId);
    }
    expect(new Set(snap.danglingCancels)).toEqual(new Set(['a-1', 'a-2', 'a-3']));
  });

  it('replay fan-out does NOT mark already-terminal activities', async () => {
    await log.append(runCreated);
    await log.append(attemptCreated('a-1', 'at-1'));
    // Terminate a-1 BEFORE the cancel.
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: 'a-1',
        attemptId: 'at-1',
        outputRef: sampleOutputRef,
      },
    });
    await requestCancel(log, {
      target: { kind: 'run', runId: RUN_ID },
      reason: 'r',
      by: 'b',
    });
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.attempts[0].cancelRequest).toBeUndefined();
    expect(snap.danglingCancels).toEqual([]);
  });

  it('replay fan-out does NOT mark activities created AFTER the cancel (scheduler responsibility)', async () => {
    await log.append(runCreated);
    await requestCancel(log, {
      target: { kind: 'run', runId: RUN_ID },
      reason: 'r',
      by: 'b',
    });
    await log.append(attemptCreated('a-1', 'at-1'));
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.attempts[0].cancelRequest).toBeUndefined();
  });

  it('overlapping cancels keep the FIRST cancelOriginEventId', async () => {
    await bootstrap('a-1', 'at-1');
    const first = await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'first',
      by: 'alice',
    });
    await requestCancel(log, {
      target: { kind: 'run', runId: RUN_ID },
      reason: 'second',
      by: 'bob',
    });
    const snap = replay(await log.readAll());
    const cr = snap.activities.get('a-1')?.attempts[0].cancelRequest;
    expect(cr?.cancelOriginEventId).toBe(first.eventId);
    expect(cr?.requestedBy).toBe('alice'); // first wins
  });
});

// ─── deliverCancel ─────────────────────────────────────────────────────────

describe('cancel — deliverCancel', () => {
  it('writes cancelDelivered and replay updates cancelRequest.delivered=true', async () => {
    await bootstrap('a-1', 'at-1');
    await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'r',
      by: 'b',
    });
    const e = await deliverCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      activityId: 'a-1',
    });
    expect(e.type).toBe('cancelDelivered');
    expect(e.actor).toBe('worker');
    const snap = replay(await log.readAll());
    const at = snap.activities.get('a-1')?.attempts[0];
    expect(at?.cancelRequest?.delivered).toBe(true);
    // Activity is still dangling — cancelDelivered isn't a terminal.
    expect(snap.danglingCancels).toContain('a-1');
  });

  it('replay tolerates cancelDelivered without prior cancelRequest (no crash, no mutation)', async () => {
    await bootstrap('a-1', 'at-1');
    await deliverCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      activityId: 'a-1',
    });
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.attempts[0].cancelRequest).toBeUndefined();
  });
});

// ─── completeActivityCancel ────────────────────────────────────────────────

describe('cancel — completeActivityCancel', () => {
  it('writes activityCanceled and replay marks attempt cancelled', async () => {
    await bootstrap('a-1', 'at-1');
    const req = await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'r',
      by: 'b',
    });
    await deliverCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      activityId: 'a-1',
    });
    await completeActivityCancel(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      cancelOriginEventId: req.eventId,
    });
    const snap = replay(await log.readAll());
    const a = snap.activities.get('a-1');
    expect(a?.status).toBe('cancelled');
    expect(a?.attempts[0].status).toBe('cancelled');
    expect(a?.attempts[0].cancelOriginEventId).toBe(req.eventId);
    // No longer dangling.
    expect(snap.danglingCancels).not.toContain('a-1');
    expect(snap.danglingActivities).not.toContain('a-1');
  });

  it('completeActivityCancel can run without cancelDelivered in between (cooperative cancel skipped)', async () => {
    await bootstrap('a-1', 'at-1');
    const req = await requestCancel(log, {
      target: { kind: 'activity', activityId: 'a-1' },
      reason: 'r',
      by: 'b',
    });
    await completeActivityCancel(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      cancelOriginEventId: req.eventId,
    });
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.status).toBe('cancelled');
  });
});
