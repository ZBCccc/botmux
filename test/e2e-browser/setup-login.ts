import {
  createBrowser,
  createPage,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  getRequiredEnv,
} from './helpers.js';

async function main() {
  console.log('=== Feishu Login Setup ===\n');

  checkPrerequisites();

  const groupUrl = getRequiredEnv('FEISHU_TEST_GROUP_URL');
  const url = new URL(groupUrl);
  const loginUrl = `${url.origin}/next/messenger`;

  console.log(`Opening browser at: ${loginUrl}`);
  console.log(
    'Please log in manually. The script will detect login and save session.\n',
  );

  const browser = await createBrowser(false); // headed mode
  const { context, page } = await createPage(browser);

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  console.log('Waiting for login to complete...');

  try {
    // Wait for messenger UI — URL will contain /next/messenger after login
    await page.waitForURL('**/next/messenger/**', { timeout: 300_000 });
    // Extra time for page to fully load
    await page.waitForTimeout(3000);

    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(
      `\nLogin successful! Session saved to: ${STORAGE_STATE_PATH}`,
    );
    console.log('You can now run: pnpm test:e2e-browser');
  } catch {
    console.error('\nLogin timed out (5 minutes). Please try again.');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
