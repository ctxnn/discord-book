import { getExport, saveSelection } from '../lib/db.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = params.get('key');
const PALETTE = ['#5865f2', '#e0512d', '#16a34a', '#b45309', '#9333ea', '#0891b2', '#db2777', '#4b5563'];

let record = null;
let pool = [];
let selected = new Set();
let view = 'selected';
let shown = [];
let lastIndex = null;
const colors = new Map();

const dayKey = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeOf = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const nameOf = (m) => m.author?.name || (m.system ? 'Discord' : 'Unknown');

function colorFor(name) {
  if (!colors.has(name)) colors.set(name, PALETTE[colors.size % PALETTE.length]);
  return colors.get(name);
}

function textOf(m) {
  if (m.text) return m.text;
  const bits = [];
  for (const a of m.attachments || []) bits.push(a.type === 'image' ? 'Image' : a.type === 'video' ? 'Video' : a.name || 'File');
  for (const s of m.stickers || []) bits.push(`Sticker: ${s.name}`);
  for (const e of m.embeds || []) bits.push(e.title || e.url || 'Link preview');
  return bits.join(' · ') || '(empty message)';
}

function metaOf(m) {
  const bits = [];
  if (m.trimmed) bits.push('only the matching sentence is kept');
  if (m.reply) bits.push(`↩ replying to ${m.reply.author || 'someone'}`);
  const images = (m.attachments || []).filter((a) => a.type === 'image').length;
  const files = (m.attachments || []).length - images;
  if (images && m.text) bits.push(`${images} image${images > 1 ? 's' : ''}`);
  if (files && m.text) bits.push(`${files} file${files > 1 ? 's' : ''}`);
  if ((m.embeds || []).length && m.text) bits.push('link preview');
  if ((m.reactions || []).length) bits.push(m.reactions.map((r) => `${r.emoji || '★'} ${r.count}`).join('  '));
  return bits.join(' · ');
}

function participantsOf(messages) {
  const byKey = new Map();
  for (const m of messages) {
    if (!m.author?.name) continue;
    const k = m.author.id || m.author.name.toLowerCase();
    const p = byKey.get(k) || { name: m.author.name, id: m.author.id || null, avatar: m.author.avatar || null, count: 0 };
    p.count += 1;
    p.avatar = p.avatar || m.author.avatar || null;
    byKey.set(k, p);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

function updateCounts() {
  $('count').textContent = selected.size.toLocaleString();
  $('n-selected').textContent = `(${selected.size.toLocaleString()})`;
  $('n-all').textContent = `(${pool.length.toLocaleString()})`;
  $('make').disabled = selected.size === 0;
  $('make').textContent = selected.size ? `Make PDF` : 'Pick at least one message';
}

function setRow(row, on) {
  row.classList.toggle('on', on);
  row.querySelector('input').checked = on;
}

function toggle(index, on) {
  const id = shown[index].id;
  if (on) selected.add(id);
  else selected.delete(id);
  const row = document.querySelector(`.row[data-index="${index}"]`);
  if (row) setRow(row, on);
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const who = $('who').value;
  shown = pool.filter((m) => (view === 'all' || selected.has(m.id))
    && (!who || nameOf(m) === who)
    && (!query || textOf(m).toLowerCase().includes(query) || nameOf(m).toLowerCase().includes(query)));
  lastIndex = null;
  const list = $('list');
  list.replaceChildren();
  if (!shown.length) {
    list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: view === 'selected' && !query && !who ? 'Nothing is in the PDF yet. Switch to “Whole chat” to add messages.' : 'No messages match.' }));
    return;
  }
  let day = null;
  let section = null;
  let dayStart = 0;
  shown.forEach((m, index) => {
    const d = dayKey(m.ts);
    if (d !== day) {
      day = d;
      dayStart = index;
      section = document.createElement('section');
      section.className = 'day';
      const head = document.createElement('div');
      head.className = 'day-head';
      head.append(Object.assign(document.createElement('span'), { textContent: d }), Object.assign(document.createElement('span'), { className: 'line' }));
      const from = dayStart;
      const all = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add day' });
      const none = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove day' });
      const bulk = (on) => { for (let i = from; i < shown.length && dayKey(shown[i].ts) === d; i++) toggle(i, on); updateCounts(); };
      all.addEventListener('click', () => bulk(true));
      none.addEventListener('click', () => bulk(false));
      head.append(all, none);
      section.append(head);
      list.append(section);
    }
    const row = document.createElement('div');
    row.className = `row${m.system ? ' system' : ''}`;
    row.dataset.index = index;
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', tabIndex: -1 });
    const time = Object.assign(document.createElement('span'), { className: 'time', textContent: timeOf(m.ts) });
    const who = Object.assign(document.createElement('span'), { className: 'who', textContent: nameOf(m) });
    who.style.color = colorFor(nameOf(m));
    const text = Object.assign(document.createElement('span'), { className: 'text', textContent: textOf(m) });
    const meta = metaOf(m);
    if (meta) text.append(Object.assign(document.createElement('span'), { className: 'meta', textContent: meta }));
    row.append(box, time, who, text);
    setRow(row, selected.has(m.id));
    section.append(row);
  });
}

function onRowClick(event) {
  const row = event.target.closest('.row');
  if (!row) return;
  const index = Number(row.dataset.index);
  const on = !selected.has(shown[index].id);
  if (event.shiftKey && lastIndex !== null) {
    const [a, b] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
    for (let i = a; i <= b; i++) toggle(i, on);
  } else {
    toggle(index, on);
  }
  lastIndex = index;
  updateCounts();
}

function bulkShown(on) {
  shown.forEach((_, i) => toggle(i, on));
  updateCounts();
}

async function makePdf() {
  $('make').disabled = true;
  $('make').textContent = 'Saving…';
  const messages = pool.filter((m) => selected.has(m.id));
  await saveSelection(key, messages, participantsOf(messages));
  const next = new URLSearchParams({ key, images: params.get('images') ?? '1', theme: params.get('theme') ?? '', download: '1' });
  location.href = chrome.runtime.getURL(`src/book/book.html?${next}`);
}

async function main() {
  record = await getExport(key);
  if (!record) throw new Error('This export is no longer saved. Make it again from the Discord tab.');
  pool = record.pool?.length ? record.pool : record.messages;
  selected = new Set(record.messages.map((m) => m.id));
  const title = record.mode === 'pair' ? `${record.pair[0]} & ${record.pair[1]}` : record.chat.title;
  $('title').textContent = title;
  document.title = `Review · ${title}`;
  const where = record.chat.kind === 'channel' ? `${record.chat.title}${record.chat.serverName ? ' · ' + record.chat.serverName : ''}` : record.chat.kind === 'group' ? 'Group DM' : 'Direct message';
  $('sub').textContent = `${where} · edition ${record.version} · ${pool.length.toLocaleString()} messages read`;
  for (const p of participantsOf(pool)) $('who').append(Object.assign(document.createElement('option'), { value: p.name, textContent: `${p.name} (${p.count})` }));
  document.querySelectorAll('.seg [data-view]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('.seg [data-view]').forEach((x) => x.classList.toggle('on', x === b));
    render();
  }));
  let timer;
  $('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
  $('who').addEventListener('change', render);
  $('list').addEventListener('click', onRowClick);
  $('add-shown').addEventListener('click', () => bulkShown(true));
  $('remove-shown').addEventListener('click', () => bulkShown(false));
  $('reset').addEventListener('click', () => {
    selected = new Set(record.autoIds || record.messages.map((m) => m.id));
    render();
    updateCounts();
  });
  $('make').addEventListener('click', () => makePdf().catch(showError));
  if (pool.length === record.messages.length) {
    view = 'all';
    document.querySelectorAll('.seg [data-view]').forEach((x) => x.classList.toggle('on', x.dataset.view === 'all'));
  }
  render();
  updateCounts();
}

function showError(error) {
  $('error').textContent = String(error?.message || error);
  $('error').hidden = false;
  updateCounts();
}

main().catch(showError);
