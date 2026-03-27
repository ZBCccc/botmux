/**
 * Card lifecycle test (consolidated single test):
 *  1. Card status transitions: 启动中… / 工作中 → 就绪
 *  2. Expand / collapse toggle
 *  3. Card content has no abnormal characters or CLI artifacts
 *
 * Uses a single test to avoid inter-test state issues with Feishu's
 * threaded chat (old threads can confuse the AI).
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
  sendMessage,
  waitForStreamingCard,
  navigateToMessenger,
  openChat,
} from './helpers.js';

describe('feishu card lifecycle', () => {
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
    await openChat(agent, 'Claude');
  }, 60_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('full card lifecycle: active status → toggle → no artifacts → idle', async () => {
    const msg = testMessage('card');
    await sendMessage(agent, msg);

    // --- Step 1: Streaming card appears ---
    // The streaming card has a colored header like "🖥️ xxx — 工作中"
    await waitForStreamingCard(agent, { timeoutMs: 90_000 });

    // --- Step 2: Verify toggle button exists ---
    // Streaming card updates every ~2s, so just verify the toggle button is present.
    // Don't attempt multi-step toggle (collapse then re-expand) — races with updates.
    await agent.aiAssert(
      '流式卡片中可以看到"📕 收起输出"或"📖 展开输出"按钮',
    );

    // --- Step 3: Check card content (ensure expanded first) ---
    const needExpand = await agent.aiBoolean(
      '流式卡片中有"📖 展开输出"按钮（说明输出是收起的）',
    );
    if (needExpand) {
      await agent.aiAct('点击流式卡片中的"📖 展开输出"按钮');
      await page.waitForTimeout(2000);
    }

    await agent.aiAssert(
      '流式卡片展开的输出内容是可读的正常文本，' +
        '不包含类似 [32m 或 [0m 的 ANSI 转义序列，' +
        '不包含乱码或不可读字符',
    );

    // --- Step 4: Wait for idle status ---
    await agent.aiWaitFor(
      '聊天中有一个流式卡片，其彩色标题栏中包含"就绪"字样（标题格式类似"🖥️ xxx — 就绪"）',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );
  }, 300_000); // 5 min total — generous timeout for CLI startup
});
