// End-to-end test in real Chrome: loads the unpacked extension into a throwaway profile,
// serves a small three-page portal on localhost, starts a guide through the live demo
// server, and checks that the overlay comes back on every new page by itself.
//
// Run from the repo root:
//   npm install --no-save puppeteer-core@24.15.0
//   node scripts/e2e-chrome.mjs
// Set CHROME_PATH if Chrome isn't in the default Windows location. Uses about 1 cent of API credit.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = fileURLToPath(new URL('../chrome-extension', import.meta.url));
const nav = '<nav><a href="/">Home</a> · <a href="/news">News</a> · <a href="/apply">Apply</a> · <a href="/contact">Contact</a></nav>';
const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0}nav{background:#12355b;padding:14px 24px}nav a{color:#fff;margin-right:12px}main{padding:24px}</style>
</head><body>${nav}<main>${body}</main></body></html>`;
const site = {
  '/': html('UniPortal - Home', '<h1>Welcome to UniPortal</h1><p>Your student hub.</p><button>Log out</button>'),
  '/apply': html('Apply - UniPortal', '<h1>Applications</h1><ul><li><a href="/apply/programs">Undergraduate programs</a></li><li><a href="/apply/exams">Exam registration</a></li><li><a href="/apply/scholarships">Scholarships</a></li></ul>'),
  '/apply/exams': html('Exam registration - UniPortal', '<h1>Exam registration</h1><form><label>Semester <select><option>Fall 2026</option></select></label> <button type="button">Register</button></form>'),
};
const server = http.createServer((req, res) => {
  res.writeHead(site[req.url] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(site[req.url] ?? html('Not found', '<h1>Not found</h1>'));
}).listen(8799, '127.0.0.1');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'scopos-e2e-')),
  defaultViewport: { width: 1000, height: 700 },
});

let failed = false;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  await sw.evaluate(() => chrome.storage.local.set({ scoposModel: 'claude-haiku-5-5' }));

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8799/');
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8799/*' }))[0].id);

  const readCard = async (label) => {
    await page.waitForSelector('.scopos-card.scopos-on .scopos-text:not([hidden])', { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 1500)); // let the cursor finish flying in
    const card = await page.evaluate(() => ({
      title: document.querySelector('.scopos-title')?.textContent,
      text: document.querySelector('.scopos-text')?.textContent,
      note: document.querySelector('.scopos-note')?.textContent,
      autoEnabled: !document.querySelector('[data-act=auto]')?.disabled,
      highlighted: document.querySelector('.scopos-box')?.classList.contains('scopos-on'),
    }));
    const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    console.log(`${label} | ${page.url()}\n   ${card.title}: ${card.text}\n   ${card.note} | auto=${card.autoEnabled} highlight=${card.highlighted} badge="${badge}"`);
    return card;
  };

  console.log('start:', await sw.evaluate(
    (id) => startGuide(id, 'Guide me to the exam registration page').then((n) => `${n} steps`, (e) => `ERROR ${e.message}`),
    tabId,
  ));

  // Follow the guide page by page until it reaches the exam registration page (at most 5 pages).
  for (let n = 1; n <= 5; n++) {
    const label = `page${n}-${new URL(page.url()).pathname.replaceAll('/', '_') || 'home'}`;
    let card = await readCard(label);
    if (page.url().endsWith('/apply/exams')) { console.log(`REACHED the goal page after ${n} pages`); break; }
    if (n === 5) throw new Error('did not reach the goal page in 5 pages');
    // Move to the last step, then Auto-Click it: that's the step that opens the next page.
    while ((await page.$eval('[data-act=next]', (b) => b.textContent)) !== 'Done') {
      await page.click('[data-act=next]');
      await new Promise((r) => setTimeout(r, 1200));
    }
    card = await page.evaluate(() => ({ autoEnabled: !document.querySelector('[data-act=auto]')?.disabled }));
    if (!card.autoEnabled) throw new Error(`${label}: Auto-Click is disabled on the last step`);
    await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('[data-act=auto]')]);
  }
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
