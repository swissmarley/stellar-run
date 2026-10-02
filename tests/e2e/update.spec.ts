import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

type Api = {
  __stellar: {
    state(): { flow: string };
    kill(): void;
    updateStatus(): { ready: boolean; toast: boolean };
    checkForUpdate(): void;
  };
};

const status = (page: Page) => page.evaluate(() => (window as unknown as Api).__stellar.updateStatus());
const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * A minimal static host for dist/ whose service worker can be "redeployed" by changing its version id, so the
 * update flow is tested end to end without network interception (which cannot see service-worker updates).
 */
let server: Server;
let origin = '';
let deploy = '';

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/stellar-run\/?/, '/');
    const file = normalize(join('dist', path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith('dist')) {
      res.writeHead(403).end();
      return;
    }
    try {
      statSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    let body: string | Buffer = readFileSync(file);
    if (file.endsWith('sw.js') && deploy) {
      body = body
        .toString('utf8')
        .replace(/const VERSION = "([0-9a-f]+)";/, `const VERSION = "$1-${deploy}";`);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://localhost:${(server.address() as AddressInfo).port}/stellar-run/`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test.beforeEach(() => {
  deploy = '';
});

async function firstVisit(page: Page): Promise<void> {
  await page.goto(origin);
  await page.getByRole('button', { name: "Let's fly" }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

test('a new deploy shows the update prompt outside play, and Reload activates it', async ({ page }) => {
  await firstVisit(page);
  const before = await cacheNames(page);
  expect(before.length).toBe(1);
  expect((await status(page)).ready).toBe(false);

  // Simulate a new deploy: a byte-different service worker (new version id → new cache).
  deploy = 'next';
  await page.evaluate(() => (window as unknown as Api).__stellar.checkForUpdate());
  await expect.poll(() => status(page), { timeout: 15_000 }).toEqual({ ready: true, toast: true });
  await expect(page.getByText('A new version of STELLAR RUN is ready.')).toBeVisible();
  // The old version keeps serving until the player chooses to reload.
  expect((await cacheNames(page)).length).toBe(2);

  // Never during a run.
  await page.getByRole('button', { name: 'PLAY' }).click();
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as Api).__stellar.state())).flow)
    .toBe('running');
  expect((await status(page)).toast).toBe(false);
  await page.evaluate(() => (window as unknown as Api).__stellar.kill());
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 5000 });
  await expect.poll(() => status(page)).toEqual({ ready: true, toast: true });

  // Reload activates the waiting worker and reloads into the new version.
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()]);
  await expect.poll(() => cacheNames(page)).toEqual([expect.stringMatching(/-next$/)]);
  expect((await status(page)).ready).toBe(false);
  // Progress survived the reload.
  await expect(page.getByRole('button', { name: 'PLAY' })).toBeVisible();
});

test('"Later" hides the prompt for the session', async ({ page }) => {
  await firstVisit(page);
  deploy = 'later';
  await page.evaluate(() => (window as unknown as Api).__stellar.checkForUpdate());
  await expect.poll(() => status(page), { timeout: 15_000 }).toEqual({ ready: true, toast: true });
  await page.getByRole('button', { name: 'Later' }).click();
  expect(await status(page)).toEqual({ ready: true, toast: false });
});
