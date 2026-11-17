// Run: node scripts/testplan/web-pages.mjs — opens every public web page on desktop + iPhone; reports HTTP errors, console errors, hydration errors, horizontal overflow.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/admin/package.json', import.meta.url).pathname);
const { chromium, devices } = require('@playwright/test');
const BASE = 'https://storyzio.app';
const PAGES = ['/vi', '/en', '/vi/genres', '/vi/genre/action', '/vi/rankings', '/vi/search?q=pirate', '/vi/story/pirate-dreams', '/vi/story/pirate-dreams/1',
  '/vi/story/pirate-dreams/4', '/vi/story/the-boy-next-free-door', '/vi/story/the-boy-next-free-door/1', '/vi/browse/comic', '/vi/coins', '/vi/premium',
  '/vi/login', '/vi/register', '/vi/forgot-password', '/vi/library', '/vi/about', '/vi/terms', '/vi/privacy', '/vi/delete-account', '/vi/no-such-page'];
const browser = await chromium.launch();
let fails = 0;
for (const [name, ctxOpts] of [['desktop', { viewport: { width: 1366, height: 860 } }], ['iphone', devices['iPhone 13']]]) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  let issues = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('status of 404')) issues.push(`console: ${m.text().slice(0, 150)}`); });
  page.on('pageerror', (e) => issues.push(`pageerror: ${String(e).slice(0, 150)}`));
  page.on('response', (r) => { if (r.status() >= 500) issues.push(`http ${r.status()} ${r.url().slice(0, 100)}`); });
  for (const p of PAGES) {
    issues = [];
    const t0 = Date.now();
    const r = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => ({ status: () => String(e).slice(0, 60) }));
    const ms = Date.now() - t0;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
    const want = p.includes('no-such') ? 404 : 200;
    const ok = r.status() === want && issues.length === 0 && overflow <= 1;
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(7)} ${r.status()} ${String(ms).padStart(5)}ms ${p}${overflow > 1 ? ` [h-scroll ${overflow}px]` : ''} ${[...new Set(issues)].join(' | ')}`);
  }
}
await browser.close();
console.log(`fails: ${fails}`);
