import { listSummaries, getSummary, getExport, deleteExport } from '../lib/db.js';
import { exportKey } from '../lib/keys.js';

const $ = (id) => document.getElementById(id);
const DISCORD = /^https:\/\/(?:ptb\.|canary\.)?discord\.com\//;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const titleOf = (s) => (s.mode === 'pair' ? `${s.pair[0]} & ${s.pair[1]} · ${s.chat.title}` : s.chat.title);
const placesOf = (s) => (s.sources?.length > 1 ? s.sources.map((x) => (x.kind === 'channel' ? x.title : 'DMs')).join(' + ') : s.chat.serverName || '');
const bare = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

let tab = null;
let chat = null;
let mode = 'pair';
let scope = 'all';
let books = [];
let authors = [];
let intoIds = null;

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = `mini ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const openBook = (key, review = false) => chrome.runtime.sendMessage({ type: 'export:open', key, options: { includeImages: $('images').checked, theme: $('theme').value, review } });

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
  const into = books.find((s) => s.key === $('into').value);
  $('go').textContent = into ? `Add to that book (edition ${into.version + 1})` : summary ? `Replace book (edition ${summary.version + 1})` : 'Create book';
  if (!summary) return;
  const line = document.createElement('span');
  line.className = 'grow';
  line.textContent = `Saved edition ${summary.version} · ${summary.messageCount.toLocaleString()} messages · ${fmtDate(summary.createdAt)}`;
  saved.append(line, button('Edit messages', () => openBook(key, true)), button('Open book', () => openBook(key)));
  if (summary.download?.id != null) saved.append(button('Show PDF', () => chrome.downloads.show(summary.download.id)));
}

function fillInto() {
  const own = currentKey();
  const choices = books.filter((s) => s.key !== own || s.key === $('into').value);
  const keep = $('into').value;
  $('into').replaceChildren(new Option('No, make a separate book', ''), ...choices.map((s) => new Option(`${titleOf(s)}${placesOf(s) ? ' · ' + placesOf(s) : ''}`, s.key)));
  $('into').value = choices.some((s) => s.key === keep) ? keep : '';
  $('into-field').hidden = mode !== 'pair' || !choices.length;
}

// Fill in the two people from the chosen book, using the names they have in
// this chat when Discord shows the same user ids here.
async function chooseBook() {
  intoIds = null;
  const key = $('into').value;
  if (key) {
    const book = await getExport(key);
    const pair = book.pair || book.participants.slice(0, 2).map((p) => p.name);
    intoIds = pair.map((name) => book.participants.find((p) => bare(p.name) === bare(name))?.id || null);
    const here = intoIds.map((id, i) => authors.find((a) => id && a.id === id)?.name || pair[i]);
    $('p1').value = here[0];
    $('p2').value = here[1];
  }
  refreshSaved();
}

async function refreshLibrary() {
  books = await listSummaries();
  if (chat) fillInto();
  $('no-books').hidden = books.length > 0;
  $('books').replaceChildren(...books.map((s) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<div class="t"></div><div class="m"></div>';
    info.querySelector('.t').textContent = titleOf(s);
    info.querySelector('.m').textContent = `${placesOf(s) ? placesOf(s) + ' · ' : ''}ed. ${s.version} · ${s.messageCount.toLocaleString()} msgs · ${fmtDate(s.createdAt)}`;
    li.append(info, button('Open', () => openBook(s.key)), button('✕', async () => {
      if (!confirm(`Delete the saved book "${titleOf(s)}"? The PDF file stays in your Downloads.`)) return;
      await deleteExport(s.key);
      refreshLibrary();
      refreshSaved();
    }, 'danger'));
    return li;
  }));
}

// The review page can leave a request to add a server channel to a book.
// Opened on another chat, the popup takes it up with everything filled in.
async function applyPending() {
  const { pendingAdd: p } = await chrome.storage.local.get('pendingAdd');
  const book = p && books.find((s) => s.key === p.into);
  if (!book || (book.chat.guildId === chat.guildId && book.chat.channelId === chat.channelId)) return;
  setMode('pair');
  $('into').value = p.into;
  await chooseBook();
  setScope('conversation');
  $('f-replies').checked = p.filter.replies;
  $('f-quick').checked = p.filter.backAndForth;
  $('f-says').value = p.filter.phrases.join(', ');
  $('f-who').value = String(p.filter.saidBy);
  const who = p.filter.saidBy === 'either' ? 'either of them' : p.pair[p.filter.saidBy];
  const what = [
    p.filter.replies && 'their replies, @mentions and quick answers to each other',
    p.filter.phrases.length && `the sentences where ${who} says ${p.filter.phrases.map((x) => `“${x}”`).join(', ')}`
  ].filter(Boolean);
  $('pending-title').textContent = `${p.title} · ${book.chat.title}`;
  $('pending-what').textContent = `From this channel: ${what.join(', and ')}. Check the two names below match how they appear here.`;
  $('pending').hidden = false;
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
  document.querySelectorAll('.seg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('pair').hidden = mode !== 'pair';
  if (mode !== 'pair') {
    $('into').value = '';
    intoIds = null;
  }
  fillInto();
  refreshSaved();
}

function setScope(next) {
  scope = next;
  document.querySelectorAll('.seg [data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
  $('conversation').hidden = scope !== 'conversation';
}

const phrasesOf = (text) => text.split(',').map((p) => p.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()).filter(Boolean);

async function start() {
  showError('');
  const options = {
    mode,
    pair: mode === 'pair' ? [$('p1').value.trim(), $('p2').value.trim()] : null,
    fromDate: $('from').value || null,
    includeImages: $('images').checked,
    theme: $('theme').value,
    review: $('review').checked,
    into: mode === 'pair' ? $('into').value || null : null,
    pairIds: mode === 'pair' && $('into').value ? intoIds : null,
    filter: { scope, replies: $('f-replies').checked, backAndForth: $('f-quick').checked, phrases: phrasesOf($('f-says').value), saidBy: $('f-who').value === 'either' ? 'either' : Number($('f-who').value) }
  };
  if (mode === 'pair' && !options.pair.every(Boolean)) return showError('Enter both names.');
  if (mode === 'pair' && scope === 'conversation' && !options.filter.replies && !options.filter.backAndForth && !options.filter.phrases.length) return showError('Tick at least one option or type words to look for.');
  await chrome.storage.local.set({ lastOptions: { includeImages: options.includeImages, theme: options.theme, review: options.review } });
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'start', options });
  if (!r?.ok) return showError(r?.error || 'Could not start.');
  if (options.into) await chrome.storage.local.remove('pendingAdd');
  window.close();
}

async function init() {
  const { lastOptions } = await chrome.storage.local.get('lastOptions');
  if (lastOptions) {
    $('images').checked = lastOptions.includeImages !== false;
    $('review').checked = lastOptions.review !== false;
    $('theme').value = lastOptions.theme || '';
    if ($('theme').selectedIndex < 0) $('theme').selectedIndex = 0;
  }
  const pinned = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = pinned ? [await chrome.tabs.get(pinned)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !DISCORD.test(tab.url)) {
    $('no-chat').hidden = false;
    return refreshLibrary();
  }
  await ensureContentScript();
  const info = await chrome.tabs.sendMessage(tab.id, { type: 'info' });
  chat = info?.chat;
  if (!chat) {
    $('no-chat').hidden = false;
    return refreshLibrary();
  }
  authors = info.authors;
  await refreshLibrary();
  $('chat').hidden = false;
  $('chat-title').textContent = chat.title;
  $('chat-sub').textContent = chat.kind === 'channel' ? `Channel in ${chat.serverName || 'a server'}` : chat.kind === 'group' ? 'Group DM' : 'Direct message';
  $('authors').replaceChildren(...info.authors.map((a) => Object.assign(document.createElement('option'), { value: a.name })));
  if (chat.kind === 'dm') {
    const [first = '', second = ''] = info.authors.map((a) => a.name);
    $('p1').value = first;
    $('p2').value = second;
  } else {
    setScope('conversation');
  }
  setMode('pair');
  if (info.busy) {
    $('go').disabled = true;
    $('go').textContent = 'Export running in this tab…';
  }
  document.querySelectorAll('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('.seg [data-scope]').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
  $('into').addEventListener('change', () => chooseBook().catch((e) => showError(String(e.message || e))));
  $('pending-cancel').addEventListener('click', async () => {
    await chrome.storage.local.remove('pendingAdd');
    $('pending').hidden = true;
    $('into').value = '';
    await chooseBook();
  });
  if (!info.busy) await applyPending();
  $('p1').addEventListener('input', refreshSaved);
  $('p2').addEventListener('input', refreshSaved);
  $('go').addEventListener('click', () => start().catch((e) => showError(String(e.message || e))));
}

init().catch((e) => {
  $('chat').hidden = false;
  showError(String(e.message || e));
});
