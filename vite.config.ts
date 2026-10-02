import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Content-Security-Policy injected into production HTML only: the game never talks to any origin but its own. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Emits dist/sw.js: a versioned, cache-first service worker precaching every build output (offline play). */
function serviceWorker(): Plugin {
  return {
    name: 'stellar-sw',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
    generateBundle(_opts, bundle) {
      const publicDir = 'public';
      const publicFiles = listFiles(publicDir).map((f) => relative(publicDir, f).split('\\').join('/'));
      const assets = Object.keys(bundle);
      const urls = ['./', ...assets, ...publicFiles.filter((f) => f !== 'sw-template.js')].sort();
      const hash = createHash('sha256');
      for (const u of urls) hash.update(u);
      for (const f of publicFiles) hash.update(readFileSync(join(publicDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync('src/sw-template.js', 'utf8');
      const source = template
        .replace('__VERSION__', JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(urls));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: '/stellar-run/',
  plugins: [serviceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
