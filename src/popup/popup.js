import { listSummaries, getSummary, deleteExport } from '../lib/db.js';
import { exportKey } from '../lib/keys.js';

const $ = (id) => document.getElementById(id);
const DISCORD = /^https:\/\/(?:ptb\.|canary\.)?discord\.com\//;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const titleOf = (s) => (s.mode === 'pair' ? `${s.pair[0]} & ${s.pair[1]} · ${s.chat.title}` : s.chat.title);

let tab = null;
let chat = null;
let mode = 'full';

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = `mini ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const openBook = (key) => chrome.runtime.sendMessage({ type: 'export:open', key, options: { includeImages: $('images').checked, theme: $('theme').value } });

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

function currentKey() {
  if (!chat) return null;
  if (mode !== 'pair') return exportKey(chat, 'full');
  const pair = [$('p1').value, $('p2').value];
  return pair.every((p) => p.trim()) ? exportKey(chat, 'pair', pair) : null;
}

async function refreshSaved() {
  const key = currentKey();
  const summary = key ? await getSummary(key) : null;
  const saved = $('saved');
  saved.replaceChildren();
  $('go').textContent = summary ? `Replace book (edition ${summary.version + 1})` : 'Create book';
  if (!summary) return;
  const line = document.createElement('span');
  line.className = 'grow';
  line.textContent = `Saved edition ${summary.version} · ${summary.messageCount.toLocaleString()} messages · ${fmtDate(summary.createdAt)}`;
  saved.append(line, button('Open book', () => openBook(key)));
  if (summary.download?.id != null) saved.append(button('Show PDF', () => chrome.downloads.show(summary.download.id)));
}

async function refreshLibrary() {
  const books = await listSummaries();
  $('no-books').hidden = books.length > 0;
  $('books').replaceChildren(...books.map((s) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<div class="t"></div><div class="m"></div>';
    info.querySelector('.t').textContent = titleOf(s);
    info.querySelector('.m').textContent = `${s.chat.serverName ? s.chat.serverName + ' · ' : ''}ed. ${s.version} · ${s.messageCount.toLocaleString()} msgs · ${fmtDate(s.createdAt)}`;
    li.append(info, button('Open', () => openBook(s.key)), button('✕', async () => {
      if (!confirm(`Delete the saved book "${titleOf(s)}"? The PDF file stays in your Downloads.`)) return;
      await deleteExport(s.key);
      refreshLibrary();
      refreshSaved();
    }, 'danger'));
    return li;
  }));
}

async function ensureContentScript() {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    if (r?.ok) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/scraper.js', 'src/content/content.js'] });
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('pair').hidden = mode !== 'pair';
  refreshSaved();
}

async function start() {
  showError('');
  const options = {
    mode,
    pair: mode === 'pair' ? [$('p1').value.trim(), $('p2').value.trim()] : null,
    fromDate: $('from').value || null,
    includeImages: $('images').checked,
    theme: $('theme').value
  };
  if (mode === 'pair' && !options.pair.every(Boolean)) return showError('Enter both names.');
  await chrome.storage.local.set({ lastOptions: { includeImages: options.includeImages, theme: options.theme } });
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'start', options });
  if (!r?.ok) return showError(r?.error || 'Could not start.');
  window.close();
}

async function init() {
  const { lastOptions } = await chrome.storage.local.get('lastOptions');
  if (lastOptions) {
    $('images').checked = lastOptions.includeImages !== false;
    $('theme').value = lastOptions.theme || 'classic';
  }
  refreshLibrary();
  const pinned = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = pinned ? [await chrome.tabs.get(pinned)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !DISCORD.test(tab.url)) {
    $('no-chat').hidden = false;
    return;
  }
  await ensureContentScript();
  const info = await chrome.tabs.sendMessage(tab.id, { type: 'info' });
  chat = info?.chat;
  if (!chat) {
    $('no-chat').hidden = false;
    return;
  }
  $('chat').hidden = false;
  $('chat-title').textContent = chat.title;
  $('chat-sub').textContent = chat.kind === 'channel' ? `Channel in ${chat.serverName || 'a server'}` : chat.kind === 'group' ? 'Group DM' : 'Direct message';
  $('authors').replaceChildren(...info.authors.map((a) => Object.assign(document.createElement('option'), { value: a.name })));
  if (chat.kind === 'channel') setMode('pair'); else refreshSaved();
  if (info.busy) {
    $('go').disabled = true;
    $('go').textContent = 'Export running in this tab…';
  }
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('p1').addEventListener('input', refreshSaved);
  $('p2').addEventListener('input', refreshSaved);
  $('go').addEventListener('click', () => start().catch((e) => showError(String(e.message || e))));
}

init().catch((e) => {
  $('chat').hidden = false;
  showError(String(e.message || e));
});
