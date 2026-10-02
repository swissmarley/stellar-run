import { expect, type Page, test } from '@playwright/test';

type Stellar = {
  state(): { flow: string; s: number; alive: boolean; score: number };
  kill(): void;
  app: { profile: { shards: number; stats: { runs: number }; best: { score: number } } };
  game: { popups: { size: number }; sim: { debugKill(): void } };
};

const st = (page: Page) =>
  page.evaluate(() => (window as unknown as { __stellar: Stellar }).__stellar.state());

async function dismissNotice(page: Page): Promise<void> {
  const ok = page.getByRole('button', { name: "Let's fly" });
  if (await ok.isVisible().catch(() => false)) await ok.click();
}

test('progress persists across reloads (save system end to end)', async ({ page }) => {
  await page.goto('./');
  await dismissNotice(page);
  await page.getByRole('button', { name: 'PLAY' }).click();
  await expect.poll(async () => (await st(page)).s, { timeout: 15_000 }).toBeGreaterThan(30);
  await page.evaluate(() => (window as unknown as { __stellar: Stellar }).__stellar.kill());
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 5000 });
  const before = await page.evaluate(
    () => (window as unknown as { __stellar: Stellar }).__stellar.app.profile,
  );
  expect(before.stats.runs).toBe(1);
  await page.reload();
  const after = await page.evaluate(
    () => (window as unknown as { __stellar: Stellar }).__stellar.app.profile,
  );
  expect(after.stats.runs).toBe(1);
  expect(after.shards).toBe(before.shards);
  expect(after.best.score).toBe(before.best.score);
  expect(after.best.score).toBeGreaterThan(0);
  // The privacy notice is only shown once.
  await expect(page.getByRole('button', { name: "Let's fly" })).toBeHidden();
});

test('menu screens open and close; settings apply text scale', async ({ page }) => {
  await page.goto('./');
  await dismissNotice(page);
  for (const name of ['Hangar', 'Upgrades', 'Missions', 'Leaderboard', 'Paint shop']) {
    await page.getByRole('button', { name, exact: false }).first().click();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'PLAY' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  const slider = page.getByRole('slider', { name: 'Text size' });
  await slider.fill('1.4');
  await slider.dispatchEvent('change');
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()),
    )
    .toBe('1.40');
});

test('pop-up pool stays fixed-size under heavy use', async ({ page }) => {
  await page.goto('./');
  await dismissNotice(page);
  const n0 = await page.locator('.popup').count();
  await page.evaluate(() => {
    const p = (
      window as unknown as {
        __stellar: { game: { popups: { show(t: string, x: number, y: number): void } } };
      }
    ).__stellar.game.popups;
    for (let i = 0; i < 500; i++) p.show(`+${i}`, 100, 100);
  });
  expect(await page.locator('.popup').count()).toBe(n0);
});

test('works offline after the first visit (service worker)', async ({ page, context, browserName }) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit service-worker support is not reliable for offline reload checks',
  );
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Give the worker a moment to finish precaching every asset.
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await dismissNotice(page);
  await expect(page.getByRole('button', { name: 'PLAY' })).toBeVisible();
  await page.getByRole('button', { name: 'PLAY' }).click();
  await expect.poll(async () => (await st(page)).flow).toBe('running');
  await context.setOffline(false);
});
