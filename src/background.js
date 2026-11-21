import { saveExport, setDownload, deleteExport, listSummaries, getSummary } from './lib/db.js';
import { exportKey } from './lib/keys.js';

const pageUrl = (key, opts) => chrome.runtime.getURL(
  `src/${opts.review ? 'review/review' : 'book/book'}.html?${new URLSearchParams({ key, images: opts.includeImages ? '1' : '0', theme: opts.theme || '', download: '1' })}`
);

async function handle(message, sender) {
  switch (message.type) {
    case 'export:save': {
      const { data, options } = message;
      const record = await saveExport({ ...data, key: exportKey(data.chat, data.mode, data.pair) });
      await chrome.tabs.create({ url: pageUrl(record.key, options), index: sender.tab ? sender.tab.index + 1 : undefined, openerTabId: sender.tab?.id });
      return { key: record.key, version: record.version };
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
