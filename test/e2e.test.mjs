import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'test/out/e2e');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'db-profile-'));
const downloads = await mkdtemp(join(tmpdir(), 'db-downloads-'));
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));

const mockHtml = await readFile(join(root, 'test/fixtures/discord-mock.html'), 'utf8');
const mockJs = await readFile(join(root, 'test/fixtures/discord-mock.js'), 'utf8');

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome', headless: true, pipe: true, userDataDir: profile,
  enableExtensions: [root], protocolTimeout: 600000, args: ['--no-sandbox', '--window-size=1280,900']
});
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'));
const sw = await swTarget.worker();
const extId = new URL(swTarget.url()).host;

async function openDiscord(path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith('https://discord.com/')) return req.continue();
    if (url.includes('discord-mock.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: mockJs });
    return req.respond({ status: 200, contentType: 'text/html', body: mockHtml });
  });
  await page.goto(`https://discord.com${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('li[id^="chat-messages-"]').length > 0);
  for (let i = 0; i < 50 && !(await sendToTab(page, { type: 'ping' }).catch(() => null))?.ok; i++) await new Promise((r) => setTimeout(r, 200));
  return page;
}

function sendToTab(page, message) {
  return sw.evaluate(async (url, message) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    return chrome.tabs.sendMessage(tab.id, message);
  }, page.url(), message);
}

async function exportFrom(page, options) {
  const before = new Set(browser.targets());
  const panelText = () => page.evaluate(() => document.getElementById('discord-book-panel')?.shadowRoot?.querySelector('.status')?.textContent || '');
  const reply = await sendToTab(page, { type: 'start', options });
  check(reply?.ok, `start accepted (${JSON.stringify(options)})`);
  const s0 = Date.now();
  const scrapeTicker = setInterval(async () => console.log(`      [scrape ${Math.round((Date.now() - s0) / 1000)}s] ${await panelText().catch(() => '?')}`), 20000);
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/src/book/book.html'), { timeout: 240000 })
    .catch(async (e) => { console.log('      panel:', await panelText()); throw e; })
    .finally(() => clearInterval(scrapeTicker));
  const book = await target.page();
  book.on('pageerror', (e) => console.log('      book error:', e.message));
  book.on('console', (m) => m.text().startsWith('[book]') && console.log(`      ${m.text()}`));
  await book.bringToFront();
  const t0 = Date.now();
  const ticker = setInterval(() => book.$eval('.db-status', (e) => e.textContent).then((s) => console.log(`      [${Math.round((Date.now() - t0) / 1000)}s] ${s}`), () => {}), 30000);
  await book.waitForFunction(() => ['done', 'error'].includes(document.querySelector('.db-toolbar')?.dataset.state), { timeout: 240000 });
  clearInterval(ticker);
  console.log(`      book finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  const statusText = await book.$eval('.db-status', (e) => e.textContent);
  console.log('      book status:', statusText);
  check(await book.$eval('.db-toolbar', (e) => e.dataset.state) === 'done', 'PDF saved automatically');
  return book;
}

const pdfFiles = async () => (await readdir(join(downloads, 'Discord Books')).catch(() => [])).filter((f) => f.endsWith('.pdf'));
async function pdfInfo(name) {
  const data = new Uint8Array(await readFile(join(downloads, 'Discord Books', name)));
  const doc = await pdfjs.getDocument({ data }).promise;
  const outline = await doc.getOutline();
  return { pages: doc.numPages, outline: outline?.length ?? 0 };
}

const dm = await openDiscord('/channels/@me/123456789012345678?kind=dm&fast');
const truth = await dm.evaluate(() => window.__mockTruth.map((m) => ({ id: m.id, author: m.authorName })));
await dm.screenshot({ path: join(out, 'discord-mock.png') });

let book = await exportFrom(dm, { mode: 'full', includeImages: true, theme: 'classic' });
let record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
const ids = record.messages.map((m) => m.id);
check(ids.length === truth.length && truth.every((t) => ids.includes(t.id)), `DM: all ${truth.length} messages exported (got ${ids.length})`);
check(record.messages.every((m, i) => i === 0 || BigInt(m.id) > BigInt(record.messages[i - 1].id)), 'DM: chronological, no duplicates');
const authorOk = truth.filter((t) => !record.messages.find((m) => m.id === t.id)?.system).every((t) => record.messages.find((m) => m.id === t.id)?.author?.name === t.author);
check(authorOk, 'DM: every author correct');
check(record.version === 1 && record.complete === true, `DM: edition 1, complete (v${record.version}, complete=${record.complete})`);
let files = await pdfFiles();
check(files.length === 1, `one PDF in Downloads/Discord Books (${files.join(', ')})`);
const firstName = files[0];
const firstSize = (await stat(join(downloads, 'Discord Books', firstName))).size;
const info = await pdfInfo(firstName);
check(info.pages > 10 && info.outline > 0, `PDF has ${info.pages} pages and ${info.outline} outline entries`);
await book.screenshot({ path: join(out, 'book-tab.png') });
await book.close();

book = await exportFrom(dm, { mode: 'full', includeImages: false, theme: 'midnight' });
record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
check(record.version === 2, `re-export is edition 2 (got ${record.version})`);
files = await pdfFiles();
const secondSize = (await stat(join(downloads, 'Discord Books', files[0]))).size;
check(files.length === 1 && files[0] === firstName && secondSize !== firstSize, `re-export replaced the same file (${files.join(', ')}, ${firstSize} -> ${secondSize} bytes)`);
const history = await sw.evaluate(() => chrome.downloads.search({}));
check(history.filter((d) => d.exists !== false && d.state === 'complete').length === 1, `download history keeps one entry (${history.length})`);
const summaries = await book.evaluate(async () => (await import('../lib/db.js')).listSummaries());
check(summaries.length === 1 && summaries[0].download?.version === 2, 'library holds one book with the new download');
await book.close();

const channel = await openDiscord('/channels/987654321098765432/123456789012345678?kind=channel&fast');
const pick = (await sendToTab(channel, { type: 'info' })).authors.map((a) => a.name);
console.log('      visible authors:', pick.join(', '));
const pair = [pick[0], pick[1].toLowerCase()];
book = await exportFrom(channel, { mode: 'pair', pair, includeImages: true, theme: 'classic' });
record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
const authors = new Set(record.messages.map((m) => m.author.name));
const channelTruth = await channel.evaluate(() => window.__mockTruth.filter((m) => !m.isSystem && m.authorName).map((m) => m.authorName));
const expected = channelTruth.filter((a) => a.toLowerCase() === pair[0].toLowerCase() || a.toLowerCase() === pair[1].toLowerCase()).length;
check(authors.size === 2 && [...authors].every((a) => pick.slice(0, 2).includes(a)), `pair mode keeps only ${[...authors].join(' & ')}`);
check(record.messages.length === expected, `pair mode has all ${expected} of their messages (got ${record.messages.length})`);
check(record.key.includes(':pair:') && record.chat.kind === 'channel', `pair record key ${record.key}`);
files = await pdfFiles();
check(files.length === 2, `pair book saved as its own PDF (${files.join(', ')})`);
await book.close();

const popup = await browser.newPage();
await popup.setViewport({ width: 360, height: 600 });
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://discord.com/channels/987654321098765432/*' }))[0].id);
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tab=${tabId}`);
await popup.waitForSelector('#chat:not([hidden])');
await popup.type('#p1', pair[0]);
await popup.type('#p2', pair[1]);
await popup.waitForFunction(() => document.getElementById('go').textContent.includes('edition 2'));
await popup.screenshot({ path: join(out, 'popup.png'), fullPage: true });
check(true, 'popup shows the saved pair book and offers edition 2');

await browser.close();
for (const f of await pdfFiles()) await copyFile(join(downloads, 'Discord Books', f), join(out, f));
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
