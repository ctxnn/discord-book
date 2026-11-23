const DB_NAME = 'discord-book';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('exports', { keyPath: 'key' });
      db.createObjectStore('summaries', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(stores, mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = fn(tx);
      tx.oncomplete = async () => resolve(await result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function summarize(record, download = null) {
  const first = record.messages[0];
  const last = record.messages[record.messages.length - 1];
  return {
    key: record.key,
    chat: record.chat,
    mode: record.mode,
    pair: record.pair,
    createdAt: record.createdAt,
    version: record.version,
    complete: record.complete,
    messageCount: record.messages.length,
    firstTs: first ? first.ts : null,
    lastTs: last ? last.ts : null,
    participants: record.participants.map(({ name, count, id }) => ({ name, count, id: id || null })),
    sources: (record.sources || []).map(({ key, chat }) => ({ key, title: chat.title, kind: chat.kind, serverName: chat.serverName || null })),
    download
  };
}

export async function saveExport(record) {
  return run(['exports', 'summaries'], 'readwrite', async (tx) => {
    const previous = await request(tx.objectStore('summaries').get(record.key));
    const saved = { ...record, version: (previous?.version ?? 0) + 1, createdAt: new Date().toISOString() };
    tx.objectStore('exports').put(saved);
    tx.objectStore('summaries').put(summarize(saved, previous?.download ?? null));
    return saved;
  });
}

export function getExport(key) {
  return run(['exports'], 'readonly', (tx) => request(tx.objectStore('exports').get(key)));
}

export function getSummary(key) {
  return run(['summaries'], 'readonly', (tx) => request(tx.objectStore('summaries').get(key)));
}

export async function listSummaries() {
  const all = await run(['summaries'], 'readonly', (tx) => request(tx.objectStore('summaries').getAll()));
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function setDownload(key, download) {
  return run(['summaries'], 'readwrite', async (tx) => {
    const store = tx.objectStore('summaries');
    const summary = await request(store.get(key));
    if (summary) store.put({ ...summary, download });
    return summary?.download ?? null;
  });
}

export function deleteExport(key) {
  return run(['exports', 'summaries'], 'readwrite', (tx) => {
    tx.objectStore('exports').delete(key);
    tx.objectStore('summaries').delete(key);
  });
}

export function saveSelection(key, messages, participants) {
  return run(['exports', 'summaries'], 'readwrite', async (tx) => {
    const record = await request(tx.objectStore('exports').get(key));
    if (!record) throw new Error('This export is no longer saved.');
    const updated = { ...record, messages, participants };
    tx.objectStore('exports').put(updated);
    const summary = await request(tx.objectStore('summaries').get(key));
    tx.objectStore('summaries').put(summarize(updated, summary?.download ?? null));
    return updated;
  });
}

