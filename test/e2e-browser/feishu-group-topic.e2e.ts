/**
 * Group chat topic/thread creation test:
 *
 * Verifies that bots reply using TOPIC REPLIES (话题回复) in regular group chats,
 * not just regular inline replies (条回复).
 *
 * Distinction:
 *  - 话题回复: reply_in_thread=true → reply only visible in thread panel,
 *    main chat shows "N条话题回复" indicator
 *  - 普通回复: reply_in_thread=false → reply appears inline in main chat,
 *    shows "N条回复" indicator
 *
 * Per requirements: bots must use topic replies in ALL chat types
 * (private, regular group, topic group).
 *
 * Fixed: daemon now sets reply_in_thread=true for all chat types.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  testMessage,
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
} from './helpers.js';

describe('group chat topic reply mode', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;

  beforeAll(async () => {
    checkPrerequisites();
    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        'storageState.json not found. Run: pnpm test:e2e-browser:setup',
      );
    }
    browser = await createBrowser();
    ({ context, page } = await createPage(browser));
    agent = createAgent(page);

    await navigateToMessenger(page);
    await openChat(page, agent, getGroupChatName());
  }, 120_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('bot uses topic replies (话题回复) in regular group, not inline replies', async () => {
    const msg = testMessage('topic-mode');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for bot to respond
    await agent.aiWaitFor(
      `聊天中"${msg}"消息附近出现了来自机器人的回复`,
      { timeoutMs: 90_000, checkIntervalMs: 5_000 },
    );

    // KEY ASSERTION: The reply should use TOPIC mode (话题回复),
    // NOT inline mode (条回复).
    //
    // With topic replies: main chat shows "N条话题回复" and replies
    // are ONLY visible inside the thread panel (not inline).
    //
    // With inline replies: main chat shows "N条回复" and the bot's
    // cards/messages appear directly in the chat feed.
    await agent.aiAssert(
      `消息"${msg}"附近显示的是"话题回复"字样（如"N条话题回复"或"查看更早N条话题回复"），` +
        '而不是"条回复"字样。' +
        '同时，机器人的回复卡片不应直接出现在群聊主消息流中，而应只在话题面板中可见。',
    );
  }, 180_000);
});
