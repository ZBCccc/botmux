// src/core/dashboard-rows.ts
//
// Pure-data row composers shared between the dashboard IPC server (which
// serves /api/sessions) and the worker-pool publishers (which emit
// `session.spawned` / `session.update` lifecycle events).  Lives in its own
// module so worker-pool can import the composer without pulling in the IPC
// server (which itself imports worker-pool — that would be a cycle).
import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';
import type { CliId } from '../adapters/cli/types.js';

export interface SessionRow {
  sessionId: string;
  larkAppId: string;
  botName: string;
  cliId: CliId | 'unknown';
  status: 'starting' | 'working' | 'idle' | 'analyzing' | 'closed';
  adopt: boolean;
  spawnedAt: number;
  lastMessageAt: number;
  closedAt?: number;
  workingDir?: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  title?: string;
  ownerOpenId?: string;
  webPort: number | null;
  cliVersion?: string;
  hasHistory?: boolean;
  feishuChatLink: string;
}

export function feishuChatLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

let cachedBotName = '';
export function setBotName(name: string): void { cachedBotName = name; }
export function getBotName(): string { return cachedBotName; }

export function composeRowFromActive(ds: DaemonSession): SessionRow {
  return {
    sessionId: ds.session.sessionId,
    larkAppId: ds.larkAppId,
    botName: cachedBotName,
    cliId: ds.session.cliId ?? 'unknown',
    status: ds.lastScreenStatus ?? 'starting',
    adopt: !!ds.adoptedFrom,
    spawnedAt: ds.spawnedAt,
    lastMessageAt: ds.lastMessageAt,
    workingDir: ds.workingDir,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    title: ds.session.title,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.workerPort ?? null,
    cliVersion: ds.cliVersion,
    hasHistory: ds.hasHistory,
    feishuChatLink: feishuChatLink(ds.chatId),
  };
}

export function composeRowFromClosed(s: Session): SessionRow {
  return {
    sessionId: s.sessionId,
    larkAppId: s.larkAppId ?? '',
    botName: cachedBotName,
    cliId: s.cliId ?? 'unknown',
    status: 'closed',
    adopt: !!s.adoptedFrom,
    spawnedAt: Date.parse(s.createdAt),
    lastMessageAt: s.closedAt ? Date.parse(s.closedAt) : Date.parse(s.createdAt),
    closedAt: s.closedAt ? Date.parse(s.closedAt) : undefined,
    workingDir: s.workingDir,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    title: s.title,
    ownerOpenId: s.ownerOpenId,
    webPort: s.webPort ?? null,
    feishuChatLink: feishuChatLink(s.chatId),
  };
}
