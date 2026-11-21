import { renderBook } from './book-render.js';
import { getExport, getSummary } from '../lib/db.js';
import { pdfFilename } from '../lib/keys.js';

const params = new URLSearchParams(location.search);
const key = params.get('key');
const options = { includeImages: params.get('images') !== '0', theme: params.get('theme') || undefined };
const reviewUrl = () => chrome.runtime.getURL(`src/review/review.html?${new URLSearchParams({ key, images: params.get('images') ?? '1', theme: params.get('theme') ?? '' })}`);

const toolbarCss = document.createElement('link');
toolbarCss.rel = 'stylesheet';
toolbarCss.href = 'toolbar.css';
document.head.appendChild(toolbarCss);

const bar = document.createElement('div');
bar.className = 'db-toolbar';
bar.innerHTML = '<span class="db-status"></span><span class="db-actions"></span>';
document.body.prepend(bar);
const statusEl = bar.querySelector('.db-status');
const actionsEl = bar.querySelector('.db-actions');

function status(text, state = 'working') {
  statusEl.textContent = text;
  bar.dataset.state = state;
}

function actions(list) {
  actionsEl.replaceChildren(...list.map(([label, fn, primary]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    return b;
  }));
}

async function readStream(tabId, handle) {
  const chunks = [];
  for (;;) {
    const { data, base64Encoded, eof } = await chrome.debugger.sendCommand({ tabId }, 'IO.read', { handle, size: 4 << 20 });
    chunks.push(base64Encoded ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(data));
    if (eof) break;
  }
  await chrome.debugger.sendCommand({ tabId }, 'IO.close', { handle });
  return new Blob(chunks, { type: 'application/pdf' });
}

async function printToPdf() {
  const { id: tabId } = await chrome.tabs.getCurrent();
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome took too long to make the PDF')), 180000); });
    const { stream } = await Promise.race([timeout, chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      transferMode: 'ReturnAsStream'
    })]).finally(() => clearTimeout(timer));
    return await readStream(tabId, stream);
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.search({ id }).then(([item]) =>
          delta.state.current === 'complete' ? resolve(item) : reject(new Error(item?.error || 'Download interrupted')));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function savePdf(record) {
  status('Typesetting the PDF…');
  const blob = await printToPdf();
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: pdfFilename(record), conflictAction: 'overwrite', saveAs: false });
    const item = await waitForDownload(id);
    await chrome.runtime.sendMessage({ type: 'download:record', key: record.key, download: { id, filename: item.filename, bytes: blob.size, savedAt: new Date().toISOString(), version: record.version } });
    return item;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function makePdf(record) {
  try {
    const item = await savePdf(record);
    const where = item.filename.split(/[\\/]/).slice(-2).join('/');
    status(`Saved ${where} (edition ${record.version})${record.version > 1 ? ', replacing the previous edition' : ''}.`, 'done');
    actions([['Show in folder', () => chrome.downloads.show(item.id), true], ['Edit messages', () => { location.href = reviewUrl(); }], ['Save again', () => makePdf(record)], ['Print…', () => window.print()]]);
  } catch (error) {
    status(`Could not save the PDF automatically: ${error.message}. Use Print and choose "Save as PDF".`, 'error');
    actions([['Print / Save as PDF…', () => window.print(), true], ['Try again', () => makePdf(record)]]);
  }
}

async function main() {
  if (!key) return status('No book selected.', 'error');
  status('Opening your chat…');
  const record = await getExport(key);
  if (!record) return status('This book is no longer saved. Make it again from the Discord tab.', 'error');
  status(`Laying out ${record.messages.length.toLocaleString()} messages…`);
  await renderBook(record, document.getElementById('book'), options);
  if (params.get('download') === '1') {
    history.replaceState(null, '', location.pathname + '?' + new URLSearchParams({ ...Object.fromEntries(params), download: '0' }));
    await makePdf(record);
  } else {
    const summary = await getSummary(key);
    status(`Edition ${record.version} · ${record.messages.length.toLocaleString()} messages`, 'done');
    actions([
      ['Save PDF', () => makePdf(record), true],
      ['Edit messages', () => { location.href = reviewUrl(); }],
      ...(summary?.download?.id != null ? [['Show last PDF', () => chrome.downloads.show(summary.download.id).catch(() => status('That PDF file was moved or deleted.', 'error'))]] : []),
      ['Print…', () => window.print()]
    ]);
  }
}

main().catch((error) => status(String(error?.message || error), 'error'));
