/**
 * Performance bench: builds the game, serves it, and flies the perfect bot through the real rendered game in
 * Playwright (Chromium on the GPU via ANGLE/Metal, plus WebKit), under several quality tiers and CPU throttling.
 * Records frame/work-time percentiles, draw calls, triangles, JS heap and V8 GC events; writes docs/perf/.
 *   node tools/bench.ts [--quick]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type Browser, chromium, devices, type Page, webkit } from '@playwright/test';
import { preview } from 'vite';

const quick = process.argv.includes('--quick');
const S = (s: number): number => (quick ? Math.min(8, s) : s);

interface Config {
  name: string;
  engine: 'chromium' | 'webkit';
  tier: 'low' | 'medium' | 'high';
  cpu: number;
  fps30: boolean;
  seconds: number;
}

// Note: Chrome's CPU throttling suspends the main thread between short tasks, so 1-2 ms frames mostly escape it;
// it is kept for one reference config only. Phone estimates scale the measured work time instead (docs/PERF.md).
const CONFIGS: Config[] = [
  { name: 'chromium-high', engine: 'chromium', tier: 'high', cpu: 1, fps30: false, seconds: S(60) },
  { name: 'chromium-medium', engine: 'chromium', tier: 'medium', cpu: 1, fps30: false, seconds: S(45) },
  { name: 'chromium-low', engine: 'chromium', tier: 'low', cpu: 1, fps30: false, seconds: S(30) },
  { name: 'chromium-medium-30fps', engine: 'chromium', tier: 'medium', cpu: 1, fps30: true, seconds: S(30) },
  { name: 'chromium-high-cpu4x', engine: 'chromium', tier: 'high', cpu: 4, fps30: false, seconds: S(30) },
  { name: 'webkit-medium', engine: 'webkit', tier: 'medium', cpu: 1, fps30: false, seconds: S(45) },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function bundleSize(): { files: number; rawKB: number; gzipKB: number; jsGzipKB: number } {
  let raw = 0;
  let gz = 0;
  let js = 0;
  const list = files('dist');
  for (const f of list) {
    const b = readFileSync(f);
    raw += b.length;
    const g = gzipSync(b, { level: 9 }).length;
    gz += g;
    if (f.endsWith('.js')) js += g;
  }
  return {
    files: list.length,
    rawKB: Math.round(raw / 1024),
    gzipKB: Math.round(gz / 1024),
    jsGzipKB: Math.round(js / 1024),
  };
}

interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
}

function gcStats(
  trace: Buffer | null,
): { minor: number; major: number; minorMaxMs: number; majorMaxMs: number } | null {
  if (!trace) return null;
  const json = JSON.parse(trace.toString('utf8')) as { traceEvents: TraceEvent[] };
  let minor = 0;
  let major = 0;
  let minorMax = 0;
  let majorMax = 0;
  for (const e of json.traceEvents) {
    if (e.ph !== 'X' || e.dur === undefined) continue;
    const ms = e.dur / 1000;
    // Main-thread GC pauses as DevTools reports them (one event per collection).
    if (e.name === 'MinorGC') {
      minor++;
      if (ms > minorMax) minorMax = ms;
    } else if (e.name === 'MajorGC') {
      major++;
      if (ms > majorMax) majorMax = ms;
    }
  }
  return { minor, major, minorMaxMs: +minorMax.toFixed(2), majorMaxMs: +majorMax.toFixed(2) };
}

async function openPage(browser: Browser, url: string, engine: 'chromium' | 'webkit'): Promise<Page> {
  const ctx = await browser.newContext(
    engine === 'chromium' ? { ...devices['Pixel 7'] } : { ...devices['iPhone 15'] },
  );
  const page = await ctx.newPage();
  await page.goto(url);
  const ok = page.getByRole('button', { name: "Let's fly" });
  if (await ok.isVisible().catch(() => false)) await ok.click();
  return page;
}

async function main(): Promise<void> {
  const build = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) throw new Error('build failed');
  const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'error' });
  const url = 'http://localhost:4174/stellar-run/';
  const results: Record<string, unknown>[] = [];
  const chrome = await chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const safari = await webkit.launch();
  try {
    for (const c of CONFIGS) {
      const browser = c.engine === 'chromium' ? chrome : safari;
      const page = await openPage(browser, url, c.engine);
      let cdp = null;
      if (c.engine === 'chromium') {
        cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: c.cpu });
      }
      type Api = {
        __stellar: { benchStart(o: unknown): Promise<void>; benchMeasure(s: number): Promise<unknown> };
      };
      await page.evaluate((o) => (window as unknown as Api).__stellar.benchStart(o), {
        tier: c.tier,
        fps30: c.fps30,
        seed: 7,
        warmup: quick ? 2 : 4,
      });
      if (c.engine === 'chromium') {
        await chrome.startTracing(page, {
          categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
        });
      }
      const r = await page.evaluate((s) => (window as unknown as Api).__stellar.benchMeasure(s), c.seconds);
      const gc = c.engine === 'chromium' ? gcStats(await chrome.stopTracing()) : null;
      let heap: number | null = null;
      if (cdp) {
        const m = (await cdp.send('Performance.getMetrics').catch(() => null)) as {
          metrics: { name: string; value: number }[];
        } | null;
        await cdp.send('Performance.enable').catch(() => {});
        const m2 = (await cdp.send('Performance.getMetrics')) as {
          metrics: { name: string; value: number }[];
        };
        const used = (
          m2.metrics.find((x) => x.name === 'JSHeapUsedSize') ??
          m?.metrics.find((x) => x.name === 'JSHeapUsedSize')
        )?.value;
        heap = used ? +(used / 1048576).toFixed(1) : null;
      }
      const row = { config: c.name, cpuThrottle: c.cpu, ...(r as object), gc, jsHeapUsedMB: heap };
      results.push(row);
      console.log(JSON.stringify(row));
      await page.context().close();
    }
  } finally {
    await chrome.close();
    await safari.close();
    await new Promise<void>((res) => server.httpServer.close(() => res()));
  }
  const out = {
    date: new Date().toISOString(),
    host: 'Apple M4 (macOS), headless Playwright',
    quick,
    bundle: bundleSize(),
    results,
  };
  mkdirSync('docs/perf', { recursive: true });
  writeFileSync(`docs/perf/bench${quick ? '-quick' : ''}.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.bundle));
}

await main();
