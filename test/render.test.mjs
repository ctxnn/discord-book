/* Render test: opens test/preview.html in headless Chrome via file://,
 * prints every house style (plus a two-person variant and a very long
 * title) with preferCSSPageSize, rasterizes showcase pages with pdftoppm
 * into test/out/pages/<style>-*.png, and screenshots the popup and the
 * progress panel with the real extension loaded.
 */
import puppeteer from 'puppeteer-core';
import { readFile, writeFile, mkdir, readdir, unlink, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'test', 'out');
const PAGES = path.join(OUT, 'pages');
const CHROME = '/usr/local/bin/google-chrome';
const PREVIEW = 'file://' + path.join(ROOT, 'test', 'preview.html');
const THEMES = ['clothbound', 'playscript', 'album'];

if (!existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME);
await mkdir(PAGES, { recursive: true });
for (const f of await readdir(PAGES)) if (f.endsWith('.png')) await unlink(path.join(PAGES, f));

const sample = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', 'sample-export.json'), 'utf8'));

// Pair-mode variant: only Alice & Ben inside a busy channel; Ben has no user id.
const pairRecord = {
  ...sample,
  key: 'ch:900000000000000001:284631905742381005:pair:alice|ben',
  mode: 'pair',
  pair: ['Alice', 'Ben'],
  complete: false,
  chat: { ...sample.chat, kind: 'channel', title: '#general', serverName: 'Quiet Hours', guildId: '900000000000000001' },
  participants: sample.participants.map((p) => (p.name === 'Ben' ? { ...p, id: null } : p)),
  messages: sample.messages.filter((m) => !m.system).map((m) => (m.author?.name === 'Ben' ? { ...m, author: { ...m.author, id: null } } : m)),
};

// A channel with a very long name, to check titles never overflow the cover.
const longRecord = {
  ...sample,
  chat: { ...sample.chat, kind: 'channel', title: '#the-extremely-long-channel-name-for-weekend-plans-and-other-matters', serverName: 'The Society for Unreasonably Long Server Names' },
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
});

async function render(record, opts) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PREVIEW + '?noauto=1', { waitUntil: 'load' });
  const result = await page.evaluate((rec, o) => window.__render(rec, o), record, opts);
  if (!result || !result.ok) throw new Error('render failed (' + JSON.stringify(opts) + '): ' + (result && result.error));
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  const broken = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter((i) => i.complete && i.naturalWidth === 0 && i.offsetParent !== null)
    .map((i) => i.outerHTML.slice(0, 120)));
  if (broken.length) throw new Error('visible broken images: ' + broken.join(' | '));
  return page;
}

async function renderAndPrint(record, opts, pdfPath) {
  const page = await render(record, opts);
  const info = await page.evaluate(() => ({
    theme: document.documentElement.className,
    title: document.title,
    h1: document.querySelectorAll('h1').length,
    h2: document.querySelectorAll('h2').length,
    h3: document.querySelectorAll('h3').length,
  }));
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
  await page.close();
  return info;
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
async function pdfText(pdfPath) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await doc.getPage(i).then((p) => p.getTextContent());
    pages.push(squash(tc.items.map((it) => it.str).join(' ')));
  }
  const outline = (await doc.getOutline()) || [];
  return { pages, outline };
}
const find = (pages, needle, from = 1) => {
  const n = squash(needle);
  for (let i = from; i <= pages.length; i++) if (pages[i - 1].includes(n)) return i;
  return null;
};
function snap(pdf, pageNo, name) {
  if (!pageNo) { console.warn('  skip ' + name + ': page not found'); return; }
  execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', '-f', String(pageNo), '-l', String(pageNo), pdf, path.join(PAGES, name)]);
}

const OPENER = { clothbound: 'chapter', playscript: 'The action takes place', album: 'days together' };
const CLOSING = { clothbound: 'The last word', playscript: 'The last line', album: 'The last word' };

for (const theme of THEMES) {
  const pdf = path.join(OUT, 'sample-' + theme + '.pdf');
  const info = await renderAndPrint(sample, { theme }, pdf);
  if (!info.theme.includes('theme-' + theme)) throw new Error(theme + ': html class is ' + info.theme);
  if (info.h1 !== 1) throw new Error(theme + ': expected exactly one h1 (cover), got ' + info.h1);
  const { pages, outline } = await pdfText(pdf);
  const n = pages.length;
  if (n <= 8) throw new Error(theme + ': only ' + n + ' pages');
  if (!outline.length) throw new Error(theme + ': PDF has no outline');
  console.log(theme + ': ' + path.basename(pdf) + ' \u2014 ' + n + ' pages, ' + outline.length + ' top-level outline entries, ' + info.h2 + ' h2 / ' + info.h3 + ' h3');

  const colophon = find(pages, 'About this Book');
  const toc = find(pages, 'Contents', colophon || 1);
  const opener = find(pages, OPENER[theme], (toc || 1) + 1);
  const image = find(pages, 'sunset at the pier', (opener || 1) + 1);
  const emoji = find(pages, 'reactor to the idea');
  const stats = find(pages, 'By the Numbers', (opener || 1) + 1);
  const closing = find(pages, CLOSING[theme], (stats || 1) + 1);
  for (const [k, v] of Object.entries({ colophon, toc, opener, image, emoji, stats, closing })) {
    if (!v) throw new Error(theme + ': could not find the ' + k + ' page');
  }
  if (!pages[colophon - 1].includes(squash('Made with Discord Book'))) throw new Error(theme + ': colophon lacks the credit');
  if (!pages[stats - 1].includes('busiest')) throw new Error(theme + ': stats page lacks the busiest day');

  snap(pdf, 1, theme + '-cover');
  if (theme === 'clothbound') {
    snap(pdf, 2, theme + '-endpaper');
    snap(pdf, find(pages, 'A conversation between'), theme + '-title');
    snap(pdf, n, theme + '-back');
  }
  if (theme === 'playscript') snap(pdf, find(pages, 'Dramatis Personae'), theme + '-cast');
  snap(pdf, colophon, theme + '-colophon');
  snap(pdf, toc, theme + '-contents');
  snap(pdf, opener, theme + '-opener');
  snap(pdf, opener + 1, theme + '-body');
  snap(pdf, image, theme + '-image');
  snap(pdf, emoji, theme + '-code-emoji');
  snap(pdf, find(pages, 'cabin-itinerary', emoji), theme + '-files');
  snap(pdf, stats, theme + '-stats');
  snap(pdf, closing, theme + '-closing');

  const pairPdf = path.join(OUT, 'sample-' + theme + '-pair.pdf');
  await renderAndPrint(pairRecord, { theme }, pairPdf);
  const pair = await pdfText(pairPdf);
  snap(pairPdf, 1, theme + '-pair-cover');
  snap(pairPdf, find(pair.pages, 'About this Book'), theme + '-pair-colophon');
  snap(pairPdf, find(pair.pages, 'sunset at the pier'), theme + '-pair-body');
  console.log(theme + ' pair: ' + pair.pages.length + ' pages');

  const longPdf = path.join(OUT, 'long-' + theme + '.pdf');
  await renderAndPrint(longRecord, { theme }, longPdf);
  snap(longPdf, 1, theme + '-long-cover');
}

// Legacy and unknown style names fall back to the first style.
for (const legacy of ['classic', 'midnight', undefined, 'nonsense']) {
  const page = await render(sample, { theme: legacy });
  const cls = await page.evaluate(() => document.documentElement.className);
  if (!cls.includes('theme-' + THEMES[0])) throw new Error('legacy theme ' + legacy + ' rendered as ' + cls);
  await page.close();
}
console.log('legacy themes (classic, midnight, none, unknown) \u2192 ' + THEMES[0]);

// includeImages: false swaps figures for italic notes, in every style
for (const theme of THEMES) {
  const page = await render(sample, { theme, includeImages: false });
  const notes = await page.evaluate(() => document.querySelectorAll('.fig-note').length);
  const figImgs = await page.evaluate(() => document.querySelectorAll('figure img').length);
  if (figImgs !== 0 || notes < 3) throw new Error(theme + ' includeImages:false \u2014 got ' + figImgs + ' imgs / ' + notes + ' notes');
  await page.close();
  console.log(theme + ' includeImages:false OK \u2014 ' + notes + ' placeholder notes, 0 figure images');
}
await browser.close();

/* ---- popup and progress panel, with the real extension loaded ---- */
{
  const profile = await mkdtemp(path.join(tmpdir(), 'db-render-profile-'));
  const ext = await puppeteer.launch({
    executablePath: CHROME, headless: true, pipe: true, userDataDir: profile,
    enableExtensions: [ROOT], args: ['--no-sandbox', '--window-size=1280,900'],
  });
  const swTarget = await ext.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'));
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  const mockHtml = await readFile(path.join(ROOT, 'test/fixtures/discord-mock.html'), 'utf8');
  const mockJs = await readFile(path.join(ROOT, 'test/fixtures/discord-mock.js'), 'utf8');
  const discord = await ext.newPage();
  await discord.setViewport({ width: 1280, height: 800 });
  await discord.setRequestInterception(true);
  discord.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith('https://discord.com/')) return req.continue();
    if (url.includes('discord-mock.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: mockJs });
    return req.respond({ status: 200, contentType: 'text/html', body: mockHtml });
  });
  await discord.goto('https://discord.com/channels/987654321098765432/123456789012345678?kind=channel', { waitUntil: 'load' });
  await discord.waitForFunction(() => document.querySelectorAll('li[id^="chat-messages-"]').length > 0);
  const send = (message) => sw.evaluate(async (url, message) => {
    const tabs = await chrome.tabs.query({});
    return chrome.tabs.sendMessage(tabs.find((t) => t.url === url).id, message);
  }, discord.url(), message);
  for (let i = 0; i < 50 && !(await send({ type: 'ping' }).catch(() => null))?.ok; i++) await new Promise((r) => setTimeout(r, 200));

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://discord.com/channels/*' }))[0].id);
  const popup = await ext.newPage();
  await popup.setViewport({ width: 360, height: 600 });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html?tab=' + tabId);
  await popup.waitForSelector('#chat:not([hidden])');
  await popup.evaluate(() => { document.querySelector('details').open = true; });
  const options = await popup.$$eval('#theme option', (os) => os.map((o) => o.value));
  if (options.join() !== THEMES.join()) throw new Error('popup themes ' + options.join() + ' do not match renderer ' + THEMES.join());
  await popup.screenshot({ path: path.join(PAGES, 'popup.png'), fullPage: true });
  await popup.click('.seg button[data-mode="full"]');
  await popup.screenshot({ path: path.join(PAGES, 'popup-full.png'), fullPage: true });
  await popup.close();

  await discord.bringToFront();
  await send({ type: 'start', options: { mode: 'full', includeImages: true, theme: 'clothbound' } });
  await discord.waitForFunction(() => document.getElementById('discord-book-panel')?.shadowRoot?.querySelector('.status')?.textContent);
  await new Promise((r) => setTimeout(r, 1200));
  await discord.screenshot({ path: path.join(PAGES, 'panel.png'), clip: { x: 1280 - 420, y: 800 - 330, width: 420, height: 330 } });
  await discord.evaluate(() => document.getElementById('discord-book-panel').shadowRoot.querySelector('.cancel').click());
  await discord.waitForFunction(() => /Cancel/.test(document.getElementById('discord-book-panel')?.shadowRoot?.querySelector('.status')?.textContent || ''));
  await new Promise((r) => setTimeout(r, 300));
  await discord.screenshot({ path: path.join(PAGES, 'panel-done.png'), clip: { x: 1280 - 420, y: 800 - 330, width: 420, height: 330 } });
  await ext.close();
  console.log('popup and panel screenshots OK');
}

await writeFile(path.join(OUT, 'render-test-ok.txt'), 'ok ' + new Date().toISOString() + '\n');
console.log('render test OK \u2014 PNGs in test/out/pages/');
