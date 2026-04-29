import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonRegistry } from '../src/dashboard/registry.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-reg-'));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeDesc(larkAppId: string, port: number, hbAgo = 0) {
  writeFileSync(join(dir, `${larkAppId}.json`), JSON.stringify({
    larkAppId, botName: larkAppId, botIndex: 0, ipcPort: port,
    pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now() - hbAgo,
  }));
}

describe('DaemonRegistry', () => {
  it('reads existing descriptors on start', async () => {
    writeDesc('appA', 7892);
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.list().length).toBe(1);
    expect(reg.getByAppId('appA')?.ipcPort).toBe(7892);
    reg.stop();
  });

  it('treats descriptor older than 90s as stale (excluded)', async () => {
    writeDesc('appOld', 7893, 95_000);
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.getByAppId('appOld')).toBeUndefined();
    reg.stop();
  });

  it('returns empty list when directory is missing or empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'botmux-reg-empty-'));
    const reg = new DaemonRegistry(empty);
    await reg.start();
    expect(reg.list()).toEqual([]);
    reg.stop();
    rmSync(empty, { recursive: true, force: true });
  });
});
