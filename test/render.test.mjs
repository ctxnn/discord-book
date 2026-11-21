/* Render test: opens test/preview.html in headless Chrome via file://,
 * prints A5 PDFs with preferCSSPageSize, and rasterizes showcase pages
 * with pdftoppm so a human (or agent) can eyeball the typesetting.
 */
import puppeteer from 'puppeteer-core';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'test', 'out');
const CHROME = '/usr/local/bin/google-chrome';
const PREVIEW = `file://${path.join(ROOT, 'test', 'preview.html')}`;

if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
await mkdir(path.join(OUT, 'pages'), { recursive: true });

const sample = JSON.parse(await readFile(path.join(ROOT, 'test', 'fixtures', 'sample-export.json'), 'utf8'));

// Pair-mode variant of the same record: only Alice & Ben inside a busy channel.
const pairRecord = {
  ...sample,
  key: 'ch:900000000000000001:284631905742381005:pair:alice|ben',
  mode: 'pair',
  pair: ['Alice', 'Ben'],
  chat: { ...sample.chat, kind: 'channel', title: '#general', serverName: 'Quiet Hours', guildId: '900000000000000001' },
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
});

async function renderAndPrint(theme, record, pdfPath) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw new Error(`page error: ${e.message}`); });
  await page.goto(`${PREVIEW}?noauto=1&theme=${theme}`, { waitUntil: 'load' });
  const result = await page.evaluate((rec, opts) => window.__render(rec, opts), record, { theme });
  if (!result || !result.ok) throw new Error(`render failed (${theme}): ${result && result.error}`);
  const broken = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter((i) => i.complete && i.naturalWidth === 0 && i.offsetParent !== null)
    .map((i) => i.outerHTML.slice(0, 120)));
  if (broken.length) throw new Error(`visible broken images (${theme}): ${broken.join(' | ')}`);
  await page.pdf({
    path: pdfPath,
    preferCSSPageSize: true,
    printBackground: true,
    outline: true,
    tagged: true,
  });
  await page.close();
  return pdfPath;
}

const classicPdf = await renderAndPrint('classic', sample, path.join(OUT, 'sample.pdf'));
const midnightPdf = await renderAndPrint('midnight', sample, path.join(OUT, 'sample-midnight.pdf'));
const pairPdf = await renderAndPrint('classic', pairRecord, path.join(OUT, 'sample-pair.pdf'));
// ---- page counts + text-based page location via pdfjs-dist
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function pageCount(pdfPath) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), isEvalSupported: false }).promise;
  return { doc, n: doc.numPages };
}

async function findPage(pdfPath, needle) {
  const { doc, n } = await pageCount(pdfPath);
  for (let i = 1; i <= n; i++) {
    const tc = await doc.getPage(i).then((p) => p.getTextContent());
    const text = tc.items.map((it) => it.str).join(' ');
    if (text.includes(needle)) return i;
  }
  return null;
}

for (const [name, pdf] of [['classic', classicPdf], ['midnight', midnightPdf], ['pair', pairPdf]]) {
  const { n } = await pageCount(pdf);
  if (n <= 8) throw new Error(`${name}: only ${n} pages — expected a real book (>8)`);
  console.log(`${name}: ${path.basename(pdf)} — ${n} pages`);
}

const classic = { pdf: classicPdf, prefix: path.join(OUT, 'pages', 'classic') };
const targets = [
  ['cover', 1],
  ['colophon', await findPage(classicPdf, 'About this Book')],
  ['toc', await findPage(classicPdf, 'Contents')],
  ['chapter1', (await findPage(classicPdf, 'Contents')) + 1],
  ['chapter1-text', (await findPage(classicPdf, 'Contents')) + 2],
  ['middle', Math.ceil((await pageCount(classicPdf)).n / 2)],
  ['image', await findPage(classicPdf, 'sunset-at-the-pier.svg')],
  ['emoji', await findPage(classicPdf, 'reactor to the idea')],
  ['fin', (await pageCount(classicPdf)).n],
  ['pair-cover', 1],
  ['midnight-cover', 1],
  ['midnight-body', (await findPage(midnightPdf, 'Contents')) + 2],
];

const pad = (n) => String(n).padStart(4, '0');
for (const f of await readdir(path.join(OUT, 'pages'))) {
  if (f.endsWith('.png')) await unlink(path.join(OUT, 'pages', f));
}
for (const [name, pageNo] of targets) {
  if (!pageNo || pageNo < 1) { console.warn(`skip ${name}: page not found`); continue; }
  const { execFileSync } = await import('node:child_process');
  execFileSync('pdftoppm', ['-png', '-r', '110', '-f', String(pageNo), '-l', String(pageNo),
    name.startsWith('midnight') ? midnightPdf : name.startsWith('pair') ? pairPdf : classic.pdf,
    `${classic.prefix}-${name}-${pad(pageNo)}`]);
}

// includeImages: false swaps figures for italic notes
{
  const page = await browser.newPage();
  await page.goto(`${PREVIEW}?noauto=1&theme=classic`, { waitUntil: 'load' });
  const result = await page.evaluate((rec, opts) => window.__render(rec, opts),
    sample, { includeImages: false });
  if (!result || !result.ok) throw new Error(`render failed (no images): ${result && result.error}`);
  const notes = await page.evaluate(() => document.querySelectorAll('.fig-note').length);
  const figImgs = await page.evaluate(() => document.querySelectorAll('figure img').length);
  if (figImgs !== 0 || notes < 3) throw new Error(`includeImages:false — expected 0 figure imgs and notes, got ${figImgs} imgs / ${notes} notes`);
  await page.close();
  console.log(`includeImages:false OK — ${notes} placeholder notes, 0 figure images`);
}
await browser.close();

await writeFile(path.join(OUT, 'render-test-ok.txt'),
  `ok ${new Date().toISOString()}\nclassic: ${await pageCount(classicPdf).then((r) => r.n)} pages\n`);

console.log('render test OK — PNGs in test/out/pages/');
