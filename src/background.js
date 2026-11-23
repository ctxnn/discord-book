import { saveExport, setDownload, deleteExport, listSummaries, getSummary, getExport } from './lib/db.js';
import { exportKey } from './lib/keys.js';

const bare = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();
const byTime = (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function countPeople(messages) {
  const people = new Map();
  for (const m of messages) {
    if (m.system || !m.author?.name) continue;
    const k = bare(m.author.name);
    const p = people.get(k) || { name: m.author.name, id: m.author.id || null, avatar: m.author.avatar || null, count: 0 };
    p.count += 1;
    p.id = p.id || m.author.id || null;
    p.avatar = p.avatar || m.author.avatar || null;
    people.set(k, p);
  }
  return [...people.values()].sort((a, b) => b.count - a.count);
}

const sourceOf = (record, key) => ({ key, chat: record.chat, mode: record.mode, pair: record.pair, filter: record.filter, complete: record.complete });

// Put one chat's messages into a saved book. Whatever that chat added before
// is replaced; the other chats' parts stay as last edited. The two people
// keep the book's names, matched by user id where Discord showed one,
// because DMs show global names and servers show nicknames.
function combine(book, data, sourceKey) {
  if (!data.pair) throw new Error('Choose "Two people" to add this chat to a book.');
  const bookKey = book.sources?.[0]?.key || book.key;
  const bookPair = book.pair || book.participants.slice(0, 2).map((p) => p.name);
  if (bookPair.length !== 2) throw new Error('That book is not between two people, so this chat cannot be added to it.');
  const bookId = (name) => book.participants.find((p) => bare(p.name) === bare(name))?.id || null;
  const here = countPeople(data.pool);
  const slots = data.pair.map((name) => {
    const id = here.find((p) => bare(p.name) === bare(name))?.id;
    return id ? bookPair.findIndex((n) => bookId(n) === id) : -1;
  });
  if (slots[0] < 0 && slots[1] < 0) slots.splice(0, 2, 0, 1);
  else if (slots[0] < 0) slots[0] = 1 - slots[1];
  else if (slots[1] < 0 || slots[1] === slots[0]) slots[1] = 1 - slots[0];
  const rename = new Map(data.pair.map((name, i) => [bare(name), bookPair[slots[i]]]));
  const adopt = (m) => {
    const out = { ...m, source: sourceKey };
    const name = m.author && rename.get(bare(m.author.name));
    if (name) out.author = { ...m.author, name };
    const replyTo = m.reply && rename.get(bare(m.reply.author));
    if (replyTo) out.reply = { ...m.reply, author: replyTo };
    return out;
  };
  const others = (list) => (list || []).map((m) => (m.source ? m : { ...m, source: bookKey })).filter((m) => m.source !== sourceKey);
  const kept = others(book.pool?.length ? book.pool : book.messages);
  const keptIds = new Set(kept.map((m) => m.id));
  const messages = [...others(book.messages), ...data.messages.map(adopt)].sort(byTime);
  const sources = [...(book.sources || [sourceOf(book, bookKey)]).filter((s) => s.key !== sourceKey), sourceOf(data, sourceKey)];
  return {
    ...book,
    messages,
    pool: [...kept, ...data.pool.map(adopt)].sort(byTime),
    autoIds: [...(book.autoIds || book.messages.map((m) => m.id)).filter((id) => keptIds.has(id)), ...data.autoIds],
    participants: countPeople(messages),
    complete: sources.every((s) => s.complete),
    sources
  };
}

const pageUrl = (key, opts) => chrome.runtime.getURL(
  `src/${opts.review ? 'review/review' : 'book/book'}.html?${new URLSearchParams({ key, images: opts.includeImages ? '1' : '0', theme: opts.theme || '', download: '1' })}`
);

async function handle(message, sender) {
  switch (message.type) {
    case 'export:save': {
      const { data, options } = message;
      const sourceKey = exportKey(data.chat, data.mode, data.pair);
      const key = options.into || sourceKey;
      const existing = await getExport(key);
      if (options.into && !existing) throw new Error('That saved book is gone. Pick another one, or make a separate book.');
      const merge = existing && (options.into || existing.sources?.length > 1);
      const record = await saveExport(merge ? combine(existing, data, sourceKey) : { ...data, key });
      await chrome.tabs.create({ url: pageUrl(record.key, options), index: sender.tab ? sender.tab.index + 1 : undefined, openerTabId: sender.tab?.id });
      return { key: record.key, version: record.version, sources: record.sources?.length || 1 };
    }
    case 'export:open': {
      await chrome.tabs.create({ url: pageUrl(message.key, message.options || { includeImages: true }) });
      return {};
    }
    case 'export:list':
      return { exports: await listSummaries() };
    case 'export:get':
      return { summary: await getSummary(message.key) };
    case 'export:delete': {
      await deleteExport(message.key);
      return {};
    }
    case 'download:record': {
      const previous = await setDownload(message.key, message.download);
      if (previous?.id != null && previous.id !== message.download.id) {
        await chrome.downloads.erase({ id: previous.id }).catch(() => {});
      }
      return {};
    }
    case 'download:show': {
      await chrome.downloads.show(message.id);
      return {};
    }
    default:
      throw new Error(`Unknown message ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message || error) })
  );
  return true;
});
