import { expect, type Page, test } from '@playwright/test';
import { GOLDEN_GENERATION } from '../../src/core/gen/golden.ts';

type Stellar = {
  state(): { flow: string; s: number; x: number; y: number; alive: boolean; score: number };
  kill(): void;
  genHash(seed: number, n: number): number;
};

function collectProblems(page: Page): { errors: string[]; foreign: string[] } {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost' && u.protocol !== 'data:' && u.protocol !== 'blob:') foreign.push(r.url());
  });
  return { errors, foreign };
}

async function flow(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __stellar: Stellar }).__stellar.state().flow);
}

test('boots, plays, dies and restarts in under 2 s with no errors or third-party requests', async ({
  page,
}) => {
  const p = collectProblems(page);
  await page.goto('./');
  await page.getByRole('button', { name: "Let's fly" }).click();
  const play = page.getByRole('button', { name: 'PLAY' });
  await expect(play).toBeVisible();
  // Thumb-reachable: the primary action sits in the lower half of the screen.
  const box = (await play.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBeGreaterThan(vp.height * 0.5);

  await play.tap();
  await expect.poll(() => flow(page)).toBe('running');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __stellar: Stellar }).__stellar.state().s))
    .toBeGreaterThan(20);

  // Measured in-page: kill the ship, then tap Retry the moment it accepts input (like an eager player).
  const elapsed = await page.evaluate(async () => {
    const st = (window as unknown as { __stellar: Stellar }).__stellar;
    const t0 = performance.now();
    st.kill();
    const retry = document.querySelector<HTMLButtonElement>('.btn-retry')!;
    while (performance.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 16));
      if (st.state().flow === 'results') retry.click();
      if (st.state().flow === 'running') return performance.now() - t0;
    }
    return Number.POSITIVE_INFINITY;
  });
  expect(elapsed, 'death → new run (ms)').toBeLessThan(2000);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeHidden();

  expect(p.errors, p.errors.join('\n')).toEqual([]);
  expect(p.foreign, 'requests to third-party origins').toEqual([]);
});

test('dragging a finger steers the ship', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: "Let's fly" }).click();
  await page.getByRole('button', { name: 'PLAY' }).tap();
  await expect.poll(() => flow(page)).toBe('running');
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height * 0.6;
  const cdp = page.context().browser()?.browserType().name() === 'chromium';
  // Synthesise a touch drag via pointer events (works in every engine).
  await page.evaluate(
    async ({ cx, cy }) => {
      const el = document.getElementById('game')!;
      const opts = (x: number, y: number): PointerEventInit => ({
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        isPrimary: true,
        bubbles: true,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', opts(cx, cy)));
      for (let i = 1; i <= 10; i++) {
        el.dispatchEvent(new PointerEvent('pointermove', opts(cx + i * 12, cy)));
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) => setTimeout(r, 600));
      el.dispatchEvent(new PointerEvent('pointerup', opts(cx + 120, cy)));
    },
    { cx, cy },
  );
  const x = await page.evaluate(() => (window as unknown as { __stellar: Stellar }).__stellar.state().x);
  expect(x, `ship x after dragging right (cdp=${cdp})`).toBeGreaterThan(2);
});

test('HUD respects the layout: pause and ability buttons are on screen', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: "Let's fly" }).click();
  await page.getByRole('button', { name: 'PLAY' }).tap();
  const vp = page.viewportSize()!;
  for (const name of ['Pause', 'Ability']) {
    const b = (await page.getByRole('button', { name }).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
    expect(b.width).toBeGreaterThanOrEqual(40);
  }
});

test('procedural generation is bit-identical in this browser engine (cross-engine determinism)', async ({
  page,
}) => {
  await page.goto('./');
  for (const [seed, want] of Object.entries(GOLDEN_GENERATION)) {
    const got = await page.evaluate(
      (sd) => (window as unknown as { __stellar: Stellar }).__stellar.genHash(sd, 200),
      Number(seed),
    );
    expect(got, `seed ${seed}`).toBe(want);
  }
});
