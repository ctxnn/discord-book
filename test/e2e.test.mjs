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
    const tab = tabs.find((t) => t.url === url && t.active) || tabs.filter((t) => t.url === url).pop();
    return chrome.tabs.sendMessage(tab.id, message);
  }, page.url(), message);
}

async function exportFrom(page, options) {
  const before = new Set(browser.targets());
  const panelText = () => page.evaluate(() => document.getElementById('discord-book-panel')?.shadowRoot?.querySelector('.status')?.textContent || '');
  await page.bringToFront();
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
check(record.messages.length === truth.length && record.complete, `re-export from the top, after Jump to Present, still reads all ${truth.length} (got ${record.messages.length})`);
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

await channel.close();
const channelFull = await openDiscord('/channels/987654321098765432/123456789012345678?kind=channel&fast');
book = await exportFrom(channelFull, { mode: 'full', includeImages: false, theme: 'album' });
const everything = (await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')))).messages;
await book.close();
const lc = (s) => (s || '').toLowerCase();
const isA = (m) => !m.system && lc(m.author?.name) === lc(pick[0]);
const isB = (m) => !m.system && lc(m.author?.name) === lc(pick[1]);
const mentionsOf = (m) => [...(m.html || '').matchAll(/<span class="mention">@?([^<]*)<\/span>/g)].map((x) => lc(x[1]));
const splitSent = (t) => t.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const seed = everything.find((m) => (isA(m) || isB(m)) && !m.reply && !mentionsOf(m).length
  && splitSent(m.text).length >= 3 && /[A-Za-z]{5,}/.test(splitSent(m.text).at(-1)));
const phrase = splitSent(seed.text).at(-1).match(/[A-Za-z]{5,}/g).sort((a, b) => b.length - a.length)[0];
const wordRe = new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, 'iu');
const expectedIds = new Set();
let prev = null;
let others = 0;
for (const m of everything) {
  const who = isA(m) ? 0 : isB(m) ? 1 : -1;
  if (who < 0) { others++; continue; }
  const other = lc(pick[1 - who]);
  if ((m.reply && lc(m.reply.author) === other) || mentionsOf(m).includes(other) || wordRe.test(m.text)) expectedIds.add(m.id);
  if (prev && prev.who !== who && Date.parse(m.ts) - Date.parse(prev.m.ts) <= 180000 && others < 5) { expectedIds.add(m.id); expectedIds.add(prev.m.id); }
  prev = { m, who };
  others = 0;
}
book = await exportFrom(channelFull, { mode: 'pair', pair: [pick[0], pick[1]], includeImages: true, theme: 'clothbound', filter: { scope: 'conversation', replies: true, backAndForth: true, phrases: [phrase] } });
record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
const gotIds = record.messages.map((m) => m.id);
await writeFile(join(out, 'conv-debug.json'), JSON.stringify({ pick, phrase, everything, record }));
for (const id of [...expectedIds].filter((id) => !gotIds.includes(id)).slice(0, 6)) { const m = everything.find((x) => x.id === id); console.log('      missing:', JSON.stringify({ a: m.author?.name, text: m.text, html: m.html, reply: m.reply, ts: m.ts })); }
for (const id of gotIds.filter((id) => !expectedIds.has(id)).slice(0, 3)) console.log('      extra:', id);
check(gotIds.length === expectedIds.size && gotIds.every((id) => expectedIds.has(id)), `conversation filter keeps exactly the ${expectedIds.size} expected messages of ${everything.length} (got ${gotIds.length}, phrase "${phrase}")`);
check(gotIds.length < record.messages.length + everything.filter((m) => isA(m) || isB(m)).length - gotIds.length, 'conversation filter is narrower than everything they wrote');
check(record.filter?.scope === 'conversation' && record.filter.phrases[0] === phrase, 'filter saved on the record');
check(record.version === 2, `same pair with a new filter replaces the pair book (edition ${record.version})`);
const marks = await book.$$eval('mark.said', (els) => els.length);
const colophon = await book.$eval('#colophon', (e) => e.textContent).catch(() => '');
check(marks > 0 && colophon.includes(phrase), `phrase highlighted ${marks}x and listed on the About page`);

const trimmed = record.messages.filter((m) => m.trimmed);
const wordRe2 = new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, 'iu');
const sentOk = trimmed.every((m) => m.text.split(/(?<=[.!?…])\s+/).filter(Boolean).every((s) => wordRe2.test(s)));
check(trimmed.length > 0, `sentence trim: ${trimmed.length} messages cut down to the matching sentences`);
check(sentOk, 'sentence trim: every kept sentence contains the typed word');
check(trimmed.every((m) => m.fullText && m.fullText.length >= m.text.length && m.fullText.includes(m.text)), 'sentence trim: the full message is kept for re-adding');
const faces = await book.evaluate(() => ({
  colophon: document.querySelectorAll('.colophon-people .person-face').length,
  speakers: document.querySelectorAll('.speaker .who-face, .speaker .who-badge').length,
  title: document.querySelectorAll('.tp-faces .tp-face, .bill-faces .bill-face, .cover-faces .face').length,
  cast: document.querySelectorAll('.cast-face').length
}));
check(faces.colophon === 2, `faces: both people on the About page (${faces.colophon})`);
check(faces.title >= 2 || faces.cast >= 2, `faces: both people on the front pages (${faces.title} title, ${faces.cast} cast)`);
check(faces.speakers > 0, `faces: avatars beside speaker names (${faces.speakers})`);
await book.close();

{
  const before = new Set(browser.targets());
  await dm.bringToFront();
  const reply = await sendToTab(dm, { type: 'start', options: { mode: 'pair', pair: ['Alice', 'Bob'], includeImages: false, review: true, filter: { scope: 'all' } } });
  check(reply?.ok, 'review flow: export started');
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url().includes('/src/review/review.html'), { timeout: 240000 });
  const review = await target.page();
  await review.bringToFront();
  await review.waitForSelector('.row');
  const initial = Number((await review.$eval('#count', (e) => e.textContent)).replace(/\D/g, ''));
  const rows = await review.$$('.row');
  for (const row of rows.slice(0, 3)) await row.click();
  await review.click('.seg [data-view="all"]');
  await review.select('#who', (await review.$$eval('#who option', (os) => os.map((o) => o.value).find((v) => v.startsWith('Charlie')))));
  await review.waitForSelector('.row:not(.on)');
  const added = await review.$eval('.row:not(.on)', (r) => r.querySelector('.text').firstChild.textContent);
  await review.click('.row:not(.on)');
  const finalCount = Number((await review.$eval('#count', (e) => e.textContent)).replace(/\D/g, ''));
  check(finalCount === initial - 2, `review: removed 3 and added 1 (${initial} -> ${finalCount})`);
  await review.screenshot({ path: join(out, 'review.png') });
  await review.click('#make');
  await review.waitForFunction(() => location.pathname.endsWith('/book.html'), { timeout: 30000 });
  await review.waitForFunction(() => ['done', 'error'].includes(document.querySelector('.db-toolbar')?.dataset.state), { timeout: 240000 });
  check(await review.$eval('.db-toolbar', (e) => e.dataset.state) === 'done', 'review: PDF saved after review');
  const saved = await review.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
  check(saved.messages.length === finalCount && saved.messages.some((m) => m.author?.name === 'Charlie' && m.text.startsWith(added.slice(0, 20))), `review: saved selection has ${saved.messages.length} messages including the added Charlie message`);
  check(saved.pool.length === truth.length, `review: whole chat kept for adding later (${saved.pool.length})`);
  await review.close();
}

{
  const dmPairKey = 'dm:123456789012345678:pair:alice|bob';
  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/src/book/book.html`).catch(() => {});
  const dmPart = await extPage.evaluate(async (key) => (await import('../lib/db.js')).getExport(key), dmPairKey);
  await extPage.close();
  const pdfBefore = (await pdfFiles()).length;
  const channelPage = await openDiscord('/channels/987654321098765432/123456789012345678?kind=channel&fast');
  const channelPairTruth = await channelPage.evaluate(() => window.__mockTruth.filter((m) => !m.system && ['Alice', 'Bob'].includes(m.authorName)).length);
  book = await exportFrom(channelPage, { mode: 'pair', pair: ['alice', 'BOB'], into: dmPairKey, includeImages: false, theme: 'clothbound', filter: { scope: 'all' } });
  record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
  check(record.key === dmPairKey && record.sources?.length === 2, `combined: channel added to the DM book (${record.key}, ${record.sources?.length} chats)`);
  check(record.messages.length === dmPart.messages.length + channelPairTruth, `combined: ${dmPart.messages.length} reviewed DM messages + ${channelPairTruth} channel messages (got ${record.messages.length})`);
  check(record.messages.every((m, i) => i === 0 || Date.parse(m.ts) >= Date.parse(record.messages[i - 1].ts)), 'combined: DM and channel messages interleaved by time');
  check(record.messages.filter((m) => m.source?.startsWith('ch:')).every((m) => ['Alice', 'Bob'].includes(m.author.name)) && record.version === dmPart.version + 1, `combined: channel part is only Alice and Bob, edition ${record.version}`);
  const venues = await book.$$eval('.interlude.venue', (els) => els.map((e) => e.textContent));
  const about = await book.$eval('#colophon', (e) => e.textContent).catch(() => '');
  check(venues.some((v) => v.includes('direct messages')) && venues.some((v) => v.includes('#general')) && about.includes('Combined from'), `combined: the book marks where each part was said (${venues.length} markers)`);
  check((await pdfFiles()).length === pdfBefore, 'combined: replaced the DM book PDF instead of adding one');
  await book.close();

  book = await exportFrom(dm, { mode: 'pair', pair: ['Alice', 'Bob'], includeImages: false, theme: 'clothbound', filter: { scope: 'all' } });
  record = await book.evaluate(async () => (await import('../lib/db.js')).getExport(new URLSearchParams(location.search).get('key')));
  const dmCount = truth.filter((t) => ['Alice', 'Bob'].includes(t.author)).length;
  check(record.sources?.length === 2 && record.messages.length === dmCount + channelPairTruth, `combined: re-reading the DM replaces only the DM part (${record.messages.length} = ${dmCount} + ${channelPairTruth})`);
  await book.close();

  const picker = await browser.newPage();
  const channelTab = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, channelPage.url());
  await picker.goto(`chrome-extension://${extId}/src/popup/popup.html?tab=${channelTab}`);
  await picker.waitForSelector('#chat:not([hidden])');
  await picker.waitForFunction((key) => [...document.querySelectorAll('#into option')].some((o) => o.value === key), {}, dmPairKey);
  await picker.select('#into', dmPairKey);
  await picker.waitForFunction(() => document.getElementById('go').textContent.startsWith('Add to that book'));
  const filled = await picker.evaluate(() => [document.getElementById('p1').value, document.getElementById('p2').value]);
  check(filled.join('&') === 'Alice&Bob', `popup: picking the DM book fills in its two people (${filled.join(' & ')})`);
  await picker.screenshot({ path: join(out, 'popup-combine.png'), fullPage: true });
  await picker.close();
  await channelPage.close();
}

const popup = await browser.newPage();
await popup.setViewport({ width: 360, height: 600 });
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://discord.com/channels/987654321098765432/*' }))[0].id);
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tab=${tabId}`);
await popup.waitForSelector('#chat:not([hidden])');
await popup.type('#p1', pair[0]);
await popup.type('#p2', pair[1]);
await popup.click('.seg [data-scope="conversation"]');
await popup.type('#f-says', 'x, see you');
await popup.waitForFunction(() => document.getElementById('go').textContent.includes('edition 3'), { timeout: 10000 }).catch(async (e) => { console.log('      popup go:', await popup.$eval('#go', (b) => b.textContent), await popup.$eval('#saved', (b) => b.textContent)); throw e; });
await popup.screenshot({ path: join(out, 'popup.png'), fullPage: true });
check(true, 'popup shows the saved pair book and offers edition 3 with the conversation filter UI');

await browser.close();
for (const f of await pdfFiles()) await copyFile(join(downloads, 'Discord Books', f), join(out, f));
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
