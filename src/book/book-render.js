/* Discord Book renderer: turns an ExportRecord into a typeset book.
 * ES module, no dependencies, CSP-safe: no inline scripts, no eval, no remote
 * resources of its own. The only parsed markup is record html, which passes
 * through the SPEC whitelist sanitizer below; everything else is textContent.
 *
 * Three house styles share one document structure:
 *   clothbound  a literary hardcover novel
 *   playscript  a printed play: acts are months, scenes are days
 *   album       a modern memoir / photobook
 */

const ALLOWED_TAGS = new Set([
  'strong', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'br', 'p',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'a', 'span', 'img',
]);
const SPAN_CLASSES = new Set(['mention', 'spoiler', 'timestamp']);
const EMOJI_SRC_RE = /^(https:\/\/cdn\.discordapp\.com\/emojis\/|data:image\/)/i;
const LINK_HREF_RE = /^https?:\/\//i;

/* ------------------------------------------------------------- sanitize */

/** Sanitize a record html field to a DocumentFragment (whitelist of SPEC). */
export function sanitizeHtml(html, doc = document) {
  const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const frag = doc.createDocumentFragment();
  sanitizeInto(parsed.body, frag, doc);
  return frag;
}

function sanitizeInto(src, dest, doc) {
  for (const node of Array.from(src.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(doc.createTextNode(node.nodeValue));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') continue; // dropped, not unwrapped
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeInto(node, dest, doc); // unwrap to children
      continue;
    }
    const el = doc.createElement(tag);
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (LINK_HREF_RE.test(href.trim())) el.setAttribute('href', href.trim());
    } else if (tag === 'span') {
      const cls = node.getAttribute('class') || '';
      if (SPAN_CLASSES.has(cls)) el.setAttribute('class', cls);
    } else if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      if (EMOJI_SRC_RE.test(src.trim())) {
        el.setAttribute('src', src.trim());
        el.setAttribute('alt', node.getAttribute('alt') || '');
        el.setAttribute('class', 'emoji');
      } else {
        continue; // a non-emoji <img> inside message html is dropped
      }
    }
    sanitizeInto(node, el, doc);
    dest.appendChild(el);
  }
}

/* --------------------------------------------------------------- themes */

export const THEMES = ['clothbound', 'playscript', 'album'];
const resolveTheme = (t) => (THEMES.includes(t) ? t : THEMES[0]);

const SERIF_HEAD = 'font-family:"EB Garamond",Georgia,serif;';
const THEME = {
  clothbound: {
    page: [138, 216],
    margin: { top: 20, bottom: 24, inner: 17, outer: 20 },
    paper: '#f7f1e3',
    board: '#4a1c21',
    muted: '#8a7c66',
    people: ['#7b2d26', '#2e5446', '#3a4a6e', '#80591c', '#5e3a63', '#2b6068', '#7b3a52'],
    head: SERIF_HEAD + 'font-size:7.6pt;letter-spacing:0.2em;font-variant-caps:all-small-caps;font-variant-numeric:oldstyle-nums;',
    folio: SERIF_HEAD + 'font-size:9pt;font-variant-numeric:oldstyle-nums;letter-spacing:0.04em;',
    fonts: 'Set in EB Garamond, with Cormorant Garamond for display and Courier Prime for code.',
    word: 'Chapter',
  },
  playscript: {
    page: [148, 210],
    margin: { top: 21, bottom: 21, inner: 18, outer: 18 },
    paper: '#faf8f2',
    board: '#faf8f2',
    muted: '#7a756c',
    people: ['#151413', '#151413', '#151413', '#151413'],
    head: 'font-family:"Libre Caslon Text",Georgia,serif;font-size:6.8pt;letter-spacing:0.24em;text-transform:uppercase;',
    folio: 'font-family:"Libre Caslon Text",Georgia,serif;font-size:8pt;font-variant-numeric:oldstyle-nums;',
    fonts: 'Set in Libre Caslon Text and Libre Caslon Display, with Courier Prime for code.',
    word: 'Act',
  },
  album: {
    page: [160, 200],
    margin: { top: 18, bottom: 22, inner: 17, outer: 19 },
    paper: '#fbfaf6',
    board: '#2441b4',
    muted: '#7a7770',
    people: ['#2441b4', '#e0512d', '#2f7a5c', '#b5781c', '#7b4aa8', '#1d7f8c', '#c23b67'],
    chapterColors: ['#2441b4', '#e0512d', '#2f6f58', '#b97a17', '#6c47a0', '#1d7280'],
    head: 'font-family:"DM Sans",system-ui,sans-serif;font-size:6.6pt;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;',
    folio: 'font-family:"DM Sans",system-ui,sans-serif;font-size:7.5pt;font-weight:700;',
    fonts: 'Set in Fraunces and DM Sans, with DM Mono for code.',
    word: '',
  },
};

/* ----------------------------------------------------------- formatting */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;

function roman(n) {
  const pairs = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of pairs) while (n >= v) { out += s; n -= v; }
  return out;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spell out 0–99 like a book would; larger numbers stay as figures. */
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  return fmtNum(n);
}

function ordinalWord(n) {
  const w = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
    'ninth', 'tenth', 'eleventh', 'twelfth'];
  if (w[n]) return w[n];
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-GB');
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (iso) => String(iso).slice(0, 10);
const dayDate = (key) => new Date(key + 'T00:00:00Z');

function clockTime(iso) {
  const d = new Date(iso);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function longDate(iso) {
  const d = new Date(iso);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

function shortDate(iso) {
  const d = new Date(iso);
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function weekdayDate(d) {
  return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function partOfDay(h) {
  if (h < 5) return 'small hours';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function fmtSize(n) {
  if (n == null) return null;
  if (typeof n === 'string') return n;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function prettyFileName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]+/g, ' ').trim();
  return base || String(name || '');
}

function cssEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]+/g, ' ');
}

function colorHex(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/* ------------------------------------------------------- typography */

const SMART_SKIP = 'code, pre';
const BLOCKS = 'p, li, blockquote, div, h1, h2, h3, figcaption';

/** Curly quotes, apostrophes, ellipses and dashes, outside code. */
function smartString(s, prev = ' ') {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const before = i ? s[i - 1] : prev;
    if (c === '"') out += /[\s([{\u2014\u2013-]/.test(before) || before === '' ? '\u201c' : '\u201d';
    else if (c === "'") out += /[\s([{\u2014\u2013-]/.test(before) || before === '' ? '\u2018' : '\u2019';
    else out += c;
  }
  return out
    .replace(/\.\.\./g, '\u2026')
    .replace(/ -- /g, ' \u2014 ')
    .replace(/(\s)-(\s)/g, '$1\u2013$2');
}

function smartenTree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest(SMART_SKIP)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let lastBlock = null;
  let prev = ' ';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const block = n.parentElement ? n.parentElement.closest(BLOCKS) : null;
    if (block !== lastBlock) { prev = ' '; lastBlock = block; }
    const v = n.nodeValue;
    n.nodeValue = smartString(v, prev);
    if (v.length) prev = v[v.length - 1];
  }
}

/* ----------------------------------------------------------------- dom */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function append(parent, ...kids) {
  for (const k of kids) if (k) parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return parent;
}

/* ----------------------------------------------------------- derivations */

function deriveMeta(record) {
  const { chat, mode, pair, participants } = record;
  const names = participants.map((p) => p.name).filter(Boolean);
  const bare = (s) => String(s || '').replace(/^[@#]/, '').trim().toLowerCase();
  let title, subtitle, people;

  if (mode === 'pair' && pair && pair.length === 2) {
    people = pair.map((n) => cap(n || 'Unknown'));
    title = people[0] + ' & ' + people[1];
    subtitle = 'in ' + chat.title + (chat.serverName ? ' \u00b7 ' + chat.serverName : '');
  } else if (chat.kind === 'channel') {
    people = names;
    title = chat.title;
    subtitle = chat.serverName || null;
  } else if (chat.kind === 'group') {
    people = names;
    title = names.length && names.length <= 3 && !chat.title ? joinNames(names) : (chat.title || joinNames(names));
    subtitle = 'A group conversation';
  } else {
    const other = participants.find((p) => bare(p.name) === bare(chat.title));
    const otherName = other ? other.name : cap(String(chat.title || 'Unknown').replace(/^@/, ''));
    if (names.length === 2) {
      people = other ? [other.name, ...names.filter((n) => n !== other.name)] : names;
      title = people[0] + ' & ' + people[1];
    } else {
      people = [otherName];
      title = otherName + ' & me';
    }
    subtitle = 'A private conversation';
  }

  const msgs = record.messages || [];
  const first = msgs.length ? new Date(msgs[0].ts) : null;
  const last = msgs.length ? new Date(msgs[msgs.length - 1].ts) : null;
  let dateRange = '';
  if (first) {
    const sameYear = first.getFullYear() === last.getFullYear();
    const sameMonth = sameYear && first.getMonth() === last.getMonth();
    dateRange = sameMonth
      ? MONTHS[first.getMonth()] + ' ' + first.getFullYear()
      : sameYear
        ? MONTHS[first.getMonth()] + ' \u2013 ' + MONTHS[last.getMonth()] + ' ' + last.getFullYear()
        : MONTHS[first.getMonth()] + ' ' + first.getFullYear() + ' \u2013 ' + MONTHS[last.getMonth()] + ' ' + last.getFullYear();
  }
  const where = chat.kind === 'channel'
    ? chat.title + (chat.serverName ? ' on ' + chat.serverName : '')
    : chat.kind === 'group' ? 'a group chat' : 'a direct message';
  return {
    title,
    subtitle,
    people: people.length ? people : ['Unknown'],
    dateRange,
    where,
    first,
    last,
    headerTitle: title,
  };
}

function chapterize(record) {
  const byMonth = new Map();
  for (const m of record.messages) {
    const d = new Date(m.ts);
    const key = d.getFullYear() + '-' + d.getMonth();
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(m);
  }
  return [...byMonth.entries()].map(([key, msgs], i) => {
    const [y, m] = key.split('-').map(Number);
    const firstDay = new Date(msgs[0].ts).getDate();
    const lastDay = new Date(msgs[msgs.length - 1].ts).getDate();
    const days = new Set(msgs.map((x) => dayKey(x.ts)));
    const hours = new Array(24).fill(0);
    for (const x of msgs) hours[new Date(x.ts).getHours()]++;
    return {
      num: i + 1,
      year: y,
      month: m,
      label: MONTHS[m] + ' ' + y,
      dayRange: firstDay === lastDay
        ? firstDay + ' ' + MONTHS[m]
        : firstDay + '\u2013' + lastDay + ' ' + MONTHS[m],
      count: msgs.length,
      days,
      peak: partOfDay(hours.indexOf(Math.max(...hours))),
      messages: msgs,
    };
  });
}

/** Consecutive non-system messages by the same author within 7 min group up. */
function groupMessages(messages) {
  const groups = [];
  const keyOf = (x) => (x.author ? (x.author.id || x.author.name || '@anon') : '@anon');
  let cur = null;
  for (const m of messages) {
    if (m.system) { groups.push({ system: m }); cur = null; continue; }
    if (cur) {
      const dt = new Date(m.ts) - new Date(cur.last.ts);
      if (keyOf(m) === keyOf(cur.last) && dt >= 0 && dt <= 7 * 60 * 1000) {
        cur.items.push(m);
        cur.last = m;
        continue;
      }
    }
    cur = { items: [m], last: m };
    groups.push(cur);
  }
  return groups;
}

const plainText = (m) => (m.text || '').replace(/\s+/g, ' ').trim();

/** A short, well-liked line from the messages, used as an epigraph or blurb. */
function pickQuote(messages, { min = 24, max = 150 } = {}) {
  let best = null, bestScore = -Infinity;
  for (const m of messages) {
    if (m.system || !m.author || /class="spoiler"/.test(m.html || '')) continue;
    const t = plainText(m);
    if (t.length < min || t.length > max || /https?:\/\//.test(t)) continue;
    const likes = (m.reactions || []).reduce((a, r) => a + (r.count || 0), 0);
    const score = likes * 10 - Math.abs(t.length - 70) / 10;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best;
}

const STOP = new Set(('the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use ' +
  'that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what ' +
  'into also back after even most then there their these thing think about would could should which while where being doing going because really still those other ' +
  'yes yeah okay lol haha also its it\u2019s i\u2019m im don\u2019t dont can\u2019t cant that\u2019s thats you\u2019re youre i\u2019ve ive i\u2019ll ill didn\u2019t didnt isn\u2019t isnt ' +
  'just got gonna wanna maybe kind sort every never always again said says said\u2019s what\u2019s whats there\u2019s let\u2019s lets one\u2019s ok oh ah hmm').split(/\s+/));

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;

function computeStats(record) {
  const msgs = record.messages.filter((m) => !m.system);
  const names = new Set(record.participants.flatMap((p) => String(p.name).toLowerCase().split(/\s+/)));
  const perDay = new Map();
  const hours = new Array(24).fill(0);
  const wordCounts = new Map();
  const emojiCounts = new Map();
  const reactionCounts = new Map();
  let totalWords = 0;
  let longest = null;

  for (const m of msgs) {
    const k = dayKey(m.ts);
    perDay.set(k, (perDay.get(k) || 0) + 1);
    hours[new Date(m.ts).getHours()]++;
    const text = plainText(m);
    const ws = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[\p{L}][\p{L}']*/gu) || [];
    totalWords += ws.length;
    if (!longest || ws.length > longest.words) longest = { m, words: ws.length };
    for (let w of ws) {
      w = w.replace(/'+$/, '').replace(/'s$/, '');
      if (w.length < 4 || names.has(w) || STOP.has(w) || STOP.has(w.replace(/'/g, '\u2019'))) continue;
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
    for (const e of text.match(EMOJI_RE) || []) emojiCounts.set(e, (emojiCounts.get(e) || 0) + 1);
    for (const alt of String(m.html || '').match(/class="emoji"[^>]*alt="(:[^"]+:)"|alt="(:[^"]+:)"[^>]*class="emoji"/g) || []) {
      const name = (alt.match(/alt="(:[^"]+:)"/) || [])[1];
      if (name) emojiCounts.set(name, (emojiCounts.get(name) || 0) + 1);
    }
    for (const r of m.reactions || []) {
      if (!r.emoji) continue;
      reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) || 0) + (r.count || 1));
    }
  }

  const days = [...perDay.keys()].sort();
  let busiest = null;
  for (const [k, n] of perDay) if (!busiest || n > busiest.count) busiest = { day: k, count: n };

  let streak = { length: 0, from: null, to: null };
  let run = 0, runStart = null, prev = null;
  for (const k of days) {
    const t = dayDate(k).getTime();
    if (prev != null && t - prev === DAY_MS) run++;
    else { run = 1; runStart = k; }
    if (run > streak.length) streak = { length: run, from: runStart, to: k };
    prev = t;
  }

  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  const span = days.length ? Math.round((dayDate(days[days.length - 1]) - dayDate(days[0])) / DAY_MS) + 1 : 0;
  const peakHour = hours.indexOf(Math.max(...hours));

  return {
    total: record.messages.length,
    spoken: msgs.length,
    activeDays: days.length,
    span,
    busiest,
    streak,
    hours,
    peakHour,
    totalWords,
    longest,
    words: top(wordCounts, 8),
    emoji: top(emojiCounts, 6),
    reactions: top(reactionCounts, 6),
  };
}

/* --------------------------------------------------------------- people */

function makePeople(record, meta, theme) {
  const parts = record.participants || [];
  const palette = THEME[theme].people;
  const index = (author) => {
    if (!author) return -1;
    let i = author.id ? parts.findIndex((p) => p.id && p.id === author.id) : -1;
    if (i < 0) i = parts.findIndex((p) => p.name === author.name);
    return i;
  };
  const hash = (s) => Math.abs([...String(s || '?')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const color = (author) => {
    if (!author) return THEME[theme].muted;
    const i = index(author);
    return palette[(i >= 0 ? i : hash(author.name)) % palette.length];
  };
  // Album: two-person books read like a conversation, one voice on each side.
  const duo = parts.length === 2;
  let leftIdx = 0;
  if (duo && record.chat.kind === 'dm') {
    const bare = (s) => String(s || '').replace(/^@/, '').toLowerCase();
    const other = parts.findIndex((p) => bare(p.name) === bare(record.chat.title));
    if (other >= 0) leftIdx = other;
  }
  const side = (author) => {
    if (!duo || !author) return 'left';
    const i = index(author);
    return i >= 0 && i !== leftIdx ? 'right' : 'left';
  };
  return { index, color, side, duo };
}

/* -------------------------------------------------------------- images */

const watchedImages = new Map(); // img -> onFail

/** Set src with failure handling: onFail runs on error, on a failure that
 *  happened before the listener existed (complete && !naturalWidth), or when
 *  the 20 s cap in finishImages() hits while the image is still pending. */
function setImage(img, url, onFail) {
  watchedImages.set(img, onFail);
  img.addEventListener('error', () => {
    if (watchedImages.delete(img) && onFail) onFail();
  }, { once: true });
  img.decoding = 'sync';
  img.src = url || '';
  if (!url) {
    if (watchedImages.delete(img) && onFail) onFail();
  } else if (img.complete && img.naturalWidth === 0) {
    if (watchedImages.delete(img) && onFail) onFail();
  } else if (img.complete) {
    watchedImages.delete(img);
  }
}

function finishImages(timeoutMs = 20000) {
  const pending = Array.from(watchedImages.keys()).filter((i) => !i.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // anything still unsettled when the cap hits gets its fallback too
      for (const img of pending) {
        const onFail = watchedImages.get(img);
        if (watchedImages.delete(img) && onFail) onFail();
        else if (!img.complete) img.classList.add('img-failed');
      }
      resolve();
    }, timeoutMs);
    let left = pending.length;
    for (const img of pending) {
      const step = () => { if (!--left) { clearTimeout(timer); resolve(); } };
      img.addEventListener('load', step, { once: true });
      img.addEventListener('error', step, { once: true });
    }
  });
}

function initialBadge(name, color, cls = 'badge') {
  const span = el('span', cls, (String(name || '?').trim().replace(/^[@#]/, '').charAt(0) || '?').toUpperCase());
  if (color) span.style.setProperty('--who', color);
  return span;
}

function avatar(ctx, person, cls = 'avatar') {
  const color = ctx.people.color(person);
  if (!person.avatar || !ctx.includeImages) return initialBadge(person.name, color, cls + ' badge');
  const img = el('img', cls);
  img.alt = '';
  img.style.setProperty('--who', color);
  setImage(img, person.avatar, () => img.replaceWith(initialBadge(person.name, color, cls + ' badge')));
  return img;
}

function failEmoji(img) {
  img.replaceWith(el('span', 'emoji-fallback', img.getAttribute('alt') || '\u2726'));
}

/* ---------------------------------------------------------------- cover */

/** Title text with the ampersand set apart, as a compositor would. */
function titled(tag, cls, text) {
  const e = el(tag, cls);
  String(text).split(/( & )/).forEach((part) => {
    if (part === ' & ') {
      e.appendChild(document.createTextNode(' '));
      e.appendChild(el('span', 'amp', '&'));
      e.appendChild(document.createTextNode(' '));
    } else if (part) {
      e.appendChild(document.createTextNode(part));
    }
  });
  return e;
}

function titleSize(title) {
  const n = [...String(title)].length;
  return n <= 12 ? 'xl' : n <= 22 ? 'l' : n <= 40 ? 'm' : 's';
}

function monogram(meta) {
  const initials = meta.people.slice(0, 2).map((n) => String(n).replace(/^[@#]/, '').charAt(0).toUpperCase());
  const m = el('div', 'monogram');
  m.appendChild(el('span', 'mono-a', initials[0] || '\u2766'));
  if (initials[1]) {
    m.appendChild(el('span', 'mono-amp', '&'));
    m.appendChild(el('span', 'mono-b', initials[1]));
  }
  return m;
}

function buildCover(ctx) {
  const { record, meta, theme } = ctx;
  const sec = el('section', 'cover');
  sec.id = 'cover';
  const h1 = titled('h1', 'book-title', meta.title);
  h1.dataset.size = titleSize(meta.title);

  if (theme === 'clothbound') {
    const frame = el('div', 'cover-frame');
    append(frame,
      el('p', 'cover-kicker', 'A Discord Book'),
      h1,
      meta.subtitle ? el('p', 'cover-sub', meta.subtitle) : null,
      el('div', 'cover-orn', '\u2767'),
      monogram(meta),
      el('p', 'cover-dates', meta.dateRange),
      el('p', 'cover-names', cap(ordinalWord(record.version)) + ' edition'));
    sec.appendChild(frame);
    return sec;
  }

  if (theme === 'playscript') {
    const acts = ctx.chapters.length;
    const bill = el('div', 'bill');
    append(bill,
      el('p', 'bill-top', 'Discord Book presents'),
      el('div', 'bill-rule'),
      h1,
      el('p', 'bill-genre', 'A play in ' + words(acts) + ' ' + (acts === 1 ? 'act' : 'acts')),
      el('div', 'bill-rule thin'));
    const cast = el('div', 'bill-cast');
    cast.appendChild(el('p', 'bill-with', 'with'));
    const names = el('p', 'bill-names');
    meta.people.slice(0, 6).forEach((n, i) => {
      if (i) names.appendChild(el('span', 'bill-dot', '\u2022'));
      names.appendChild(el('span', null, n));
    });
    if (meta.people.length > 6) names.appendChild(el('span', 'bill-more', ' and company'));
    cast.appendChild(names);
    bill.appendChild(cast);
    const press = pickQuote(record.messages, { min: 14, max: 64 });
    if (press) {
      const review = el('div', 'bill-press');
      review.appendChild(el('p', 'bill-press-quote', smartString('\u201c' + plainText(press) + '\u201d')));
      review.appendChild(el('p', 'bill-press-by', '\u2014 ' + (press.author?.name || 'Unknown')));
      bill.appendChild(review);
    }
    append(bill,
      el('div', 'bill-rule thin'),
      el('p', 'bill-venue', 'Staged in ' + meta.where),
      el('p', 'bill-dates', meta.dateRange),
      el('p', 'bill-foot', cap(ordinalWord(record.version)) + ' edition \u00b7 ' + fmtNum(record.messages.length) + ' lines'));
    sec.appendChild(bill);
    return sec;
  }

  // album
  append(sec,
    el('p', 'cover-kicker', 'A Discord Book \u00b7 ' + cap(ordinalWord(record.version)) + ' edition'),
    h1,
    meta.subtitle ? el('p', 'cover-sub', meta.subtitle) : null);
  const strip = el('div', 'cover-tiles');
  if (ctx.includeImages) {
    const pics = record.messages.flatMap((m) => (m.attachments || []).filter((a) => a.type === 'image' && a.url)).slice(0, 3);
    for (const a of pics) {
      const tile = el('div', 'tile');
      const img = el('img');
      img.alt = '';
      setImage(img, a.url, () => tile.remove());
      tile.appendChild(img);
      strip.appendChild(tile);
    }
  }
  const foot = el('div', 'cover-foot');
  const faces = el('div', 'cover-faces');
  for (const p of record.participants.slice(0, 5)) faces.appendChild(avatar(ctx, p, 'face'));
  append(foot, faces,
    el('p', 'cover-dates', meta.dateRange),
    el('p', 'cover-count', fmtNum(record.messages.length) + ' messages'));
  append(sec, strip, foot);
  return sec;
}

/* ------------------------------------------------- title pages (cloth) */

function buildHalfTitle(ctx) {
  const sec = el('section', 'front halftitle');
  sec.appendChild(titled('p', 'ht-title', ctx.meta.title));
  return sec;
}

function buildEndpaper(ctx, withPlate) {
  const sec = el('section', 'endpaper');
  if (withPlate) {
    const plate = el('div', 'bookplate');
    append(plate,
      el('p', 'bp-ex', 'Ex Libris'),
      el('div', 'bp-orn', '\u2767'),
      titled('p', 'bp-title', ctx.meta.title),
      el('p', 'bp-line', cap(ordinalWord(ctx.record.version)) + ' edition \u00b7 ' + longDate(ctx.record.createdAt || new Date().toISOString())));
    sec.appendChild(plate);
  }
  return sec;
}

/** Facing the title page: the conversation's first words, set as an epigraph. */
function buildFrontis(ctx) {
  const sec = el('section', 'front frontis');
  const first = ctx.record.messages.find((m) => !m.system && plainText(m));
  if (first) {
    let t = plainText(first);
    if (t.length > 200) t = t.slice(0, 198).trim() + '\u2026';
    const q = el('blockquote', 'epigraph');
    q.appendChild(el('p', 'epi-text', smartString(t)));
    q.appendChild(el('p', 'epi-attr', '\u2014 ' + (first.author?.name || 'Unknown') + ', ' + longDate(first.ts)));
    sec.appendChild(el('p', 'frontis-label', ctx.record.complete ? 'In the beginning' : 'As this edition begins'));
    sec.appendChild(q);
  }
  return sec;
}

function buildTitlePage(ctx) {
  const { meta, record } = ctx;
  const sec = el('section', 'front titlepage');
  const top = el('div', 'tp-top');
  append(top,
    titled('p', 'tp-title', meta.title),
    meta.subtitle ? el('p', 'tp-sub', meta.subtitle) : null,
    el('div', 'tp-orn', '\u2767'),
    el('p', 'tp-by', 'A conversation between'),
    el('p', 'tp-names', meta.people.length > 6
      ? meta.people.slice(0, 5).join(', ') + ' and ' + words(meta.people.length - 5) + ' others'
      : joinNames(meta.people)));
  const imprint = el('div', 'tp-imprint');
  append(imprint,
    el('div', 'tp-device', '\u2767'),
    el('p', 'tp-house', 'Discord Book'),
    el('p', 'tp-year', String(new Date(record.createdAt || Date.now()).getFullYear())));
  append(sec, top, imprint);
  return sec;
}

/* ------------------------------------------------------------ colophon */

function buildColophon(ctx) {
  const { record, meta, theme } = ctx;
  const sec = el('section', 'front colophon');
  sec.id = 'colophon';
  const inner = el('div', 'colophon-inner');
  inner.appendChild(el('h2', 'front-title', 'About this Book'));

  const list = el('dl', 'colophon-list');
  const row = (key, val) => {
    const r = el('div', 'colophon-row');
    r.appendChild(el('dt', null, key));
    const v = el('dd');
    if (typeof val === 'string') v.textContent = val;
    else v.appendChild(val);
    r.appendChild(v);
    list.appendChild(r);
  };

  row('Edition', cap(ordinalWord(record.version)) + ' edition'
    + (record.version > 1 ? ', replacing the ' + ordinalWord(record.version - 1) : ''));
  row('Exported', longDate(record.createdAt || new Date().toISOString()));
  let source;
  if (record.chat.kind === 'channel') {
    source = 'The ' + record.chat.title + ' channel' + (record.chat.serverName ? ' of ' + record.chat.serverName : '');
  } else if (record.chat.kind === 'group') {
    source = 'A group direct message' + (record.chat.title ? ', ' + record.chat.title : '');
  } else {
    const bare = String(record.chat.title || '').replace(/^@/, '');
    const match = record.participants.find((p) => p.name.toLowerCase() === bare.toLowerCase());
    source = 'A direct message with ' + (match ? match.name : bare || 'someone');
  }
  row('Source', source + ', on Discord');
  row('Messages', fmtNum(record.messages.length)
    + (meta.first ? ', ' + longDate(meta.first.toISOString()) + ' to ' + longDate(meta.last.toISOString()) : ''));
  const parts = el('span', 'colophon-people');
  record.participants.forEach((p, i) => {
    const s = el('span', 'person');
    s.appendChild(el('span', 'person-name', p.name));
    const n = p.count ?? 0;
    s.appendChild(el('span', 'person-count', ' (' + fmtNum(n) + (i ? ')' : n === 1 ? ' message)' : ' messages)')));
    if (i) parts.appendChild(document.createTextNode(i === record.participants.length - 1 ? ' and ' : ', '));
    parts.appendChild(s);
  });
  row('Participants', record.participants.length ? parts : 'None recorded');
  row('History', record.complete
    ? 'Complete: this book begins with the very first message.'
    : 'Partial: the conversation began before the first page; earlier messages were not collected.');
  row('Mode', record.mode !== 'pair'
    ? 'Whole chat: every message in the conversation.'
    : record.filter?.scope !== 'conversation'
      ? 'Two people only: everything ' + joinNames((record.pair || []).map(cap)) + ' wrote, taken from a busier conversation.'
      : 'Two people only: the conversation between ' + joinNames((record.pair || []).map(cap)) + ', taken from a busier channel. Kept: ' + [
        record.filter.replies && 'their replies to and @mentions of each other',
        record.filter.backAndForth && 'quick answers to each other within three minutes',
        record.filter.phrases?.length && 'every message where either says ' + record.filter.phrases.map((p) => '\u201c' + p + '\u201d').join(', ') + ' (highlighted)'
      ].filter(Boolean).join('; ') + '.');
  inner.appendChild(list);

  inner.appendChild(el('p', 'colophon-fonts', THEME[theme].fonts));
  if (theme === 'clothbound') {
    const key = [];
    for (let i = 10; i >= Math.max(1, record.version); i--) key.push(i);
    if (record.version <= 10) inner.appendChild(el('p', 'printer-key', key.join('  ')));
  }
  const made = el('p', 'colophon-made', 'Made with ');
  made.appendChild(el('b', null, 'Discord Book'));
  inner.appendChild(made);
  sec.appendChild(inner);
  return sec;
}

/* ------------------------------------------------- dramatis personae */

function buildCast(ctx) {
  const { record, meta } = ctx;
  const sec = el('section', 'front cast');
  sec.id = 'cast';
  sec.appendChild(el('h2', 'front-title', 'Dramatis Personae'));
  const list = el('ul', 'cast-list');
  const shown = record.participants.slice(0, 14);
  for (const p of shown) {
    const li = el('li');
    li.appendChild(el('span', 'cast-name', p.name));
    li.appendChild(el('span', 'cast-lead'));
    const n = p.count ?? 0;
    li.appendChild(el('span', 'cast-role', words(n) === fmtNum(n) ? fmtNum(n) + ' lines' : cap(words(n)) + (n === 1 ? ' line' : ' lines')));
    list.appendChild(li);
  }
  if (record.participants.length > shown.length) {
    const li = el('li', 'cast-more');
    li.appendChild(el('span', 'cast-name', 'and ' + words(record.participants.length - shown.length) + ' others'));
    list.appendChild(li);
  }
  sec.appendChild(list);
  const setting = el('div', 'cast-setting');
  append(setting,
    el('p', 'cast-label', 'The scene'),
    el('p', null, cap(meta.where) + ', on Discord.'),
    el('p', 'cast-label', 'The time'),
    el('p', null, meta.dateRange + (record.complete ? '' : '; the play opens partway through.')));
  sec.appendChild(setting);
  return sec;
}

/* ------------------------------------------------------------------ toc */

function buildToc(ctx) {
  const { chapters, theme } = ctx;
  const sec = el('nav', 'front toc');
  sec.id = 'contents';
  sec.appendChild(el('h2', 'front-title', 'Contents'));
  const list = el('ol', 'toc-list');
  const max = Math.max(1, ...chapters.map((c) => c.count));
  for (const ch of chapters) {
    const li = el('li', 'toc-entry');
    const a = el('a');
    a.href = '#ch-' + ch.num;
    const num = theme === 'album' ? pad2(ch.num) : theme === 'playscript' ? 'Act ' + roman(ch.num) : roman(ch.num);
    a.appendChild(el('span', 'toc-num', num));
    const main = el('span', 'toc-main');
    main.appendChild(el('span', 'toc-label', theme === 'playscript' ? ch.label : MONTHS[ch.month]));
    if (theme !== 'playscript') main.appendChild(el('span', 'toc-year', ' ' + ch.year));
    a.appendChild(main);
    a.appendChild(el('span', 'toc-lead'));
    const metaText = theme === 'playscript'
      ? words(ch.days.size) === fmtNum(ch.days.size)
        ? fmtNum(ch.days.size) + ' scenes'
        : cap(words(ch.days.size)) + (ch.days.size === 1 ? ' scene' : ' scenes')
      : ch.dayRange + ' \u00b7 ' + fmtNum(ch.count) + (ch.count === 1 ? ' message' : ' messages');
    a.appendChild(el('span', 'toc-meta', metaText));
    if (theme === 'album') {
      const bar = el('span', 'toc-bar');
      bar.style.setProperty('--w', (ch.count / max * 100).toFixed(1) + '%');
      a.appendChild(bar);
    }
    li.appendChild(a);
    list.appendChild(li);
  }
  sec.appendChild(list);
  const back = el('ul', 'toc-back');
  for (const [href, label] of [['#numbers', 'By the Numbers'], ['#fin', theme === 'playscript' ? 'Curtain' : theme === 'album' ? 'Until next time' : 'The End']]) {
    const li = el('li');
    const a = el('a', null, label);
    a.href = href;
    li.appendChild(a);
    back.appendChild(li);
  }
  sec.appendChild(back);
  return sec;
}

/* ------------------------------------------------------ chapter opener */

function buildOpener(ctx, ch) {
  const { theme } = ctx;
  const sec = el('section', 'opener');
  sec.id = 'ch-' + ch.num;
  const n = ch.count;
  const countWords = words(n) === fmtNum(n) ? fmtNum(n) : cap(words(n));

  if (theme === 'clothbound') {
    append(sec,
      el('p', 'op-kicker', 'Chapter'),
      el('p', 'op-num', roman(ch.num)),
      el('h2', 'op-title', ch.label),
      el('p', 'op-meta', countWords + (n === 1 ? ' message' : ' messages') + ' \u00b7 ' + ch.dayRange));
    const q = pickQuote(ch.messages);
    if (q) {
      const epi = el('blockquote', 'epigraph');
      epi.appendChild(el('p', 'epi-text', smartString(plainText(q))));
      epi.appendChild(el('p', 'epi-attr', '\u2014 ' + (q.author?.name || 'Unknown') + ', ' + shortDate(q.ts)));
      sec.appendChild(epi);
    }
    return sec;
  }

  if (theme === 'playscript') {
    const castNames = [];
    for (const m of ch.messages) {
      const name = m.author?.name;
      if (name && !m.system && !castNames.includes(name)) castNames.push(name);
    }
    const scenes = ch.days.size;
    const synopsis = 'The action takes place over ' + words(scenes) + (scenes === 1 ? ' day' : ' days')
      + ' of ' + ch.label + ', mostly in the ' + ch.peak + '.';
    append(sec,
      el('p', 'op-num', 'Act ' + roman(ch.num)),
      el('div', 'op-rule'),
      el('h2', 'op-title', ch.label),
      el('p', 'op-synopsis', synopsis));
    const cast = el('p', 'op-cast');
    cast.appendChild(el('span', 'op-cast-label', 'In this act'));
    castNames.slice(0, 8).forEach((nm, i) => {
      if (i) cast.appendChild(el('span', 'op-cast-sep', '\u00b7'));
      cast.appendChild(el('span', 'op-cast-name', nm));
    });
    if (castNames.length > 8) cast.appendChild(el('span', 'op-cast-name', ' and others'));
    sec.appendChild(cast);
    return sec;
  }

  // album: full-bleed colour page with a calendar of the month
  const colors = THEME.album.chapterColors;
  sec.style.setProperty('--bleed', colors[(ch.num - 1) % colors.length]);
  const top = el('div', 'op-top');
  append(top,
    el('p', 'op-kicker', 'Chapter ' + pad2(ch.num)),
    el('p', 'op-num', pad2(ch.month + 1)),
    el('h2', 'op-title', ch.label));
  const cal = el('div', 'op-cal');
  for (const w of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) cal.appendChild(el('span', 'cal-head', w));
  const first = new Date(ch.year, ch.month, 1);
  const daysIn = new Date(ch.year, ch.month + 1, 0).getDate();
  const perDay = new Map();
  for (const m of ch.messages) {
    const k = dayKey(m.ts);
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }
  const busiest = Math.max(1, ...perDay.values());
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) cal.appendChild(el('span', 'cal-pad'));
  for (let d = 1; d <= daysIn; d++) {
    const k = ch.year + '-' + pad2(ch.month + 1) + '-' + pad2(d);
    const c = el('span', 'cal-day', String(d));
    const v = perDay.get(k);
    if (v) {
      c.classList.add('on');
      c.style.setProperty('--heat', (0.35 + 0.65 * v / busiest).toFixed(2));
    }
    cal.appendChild(c);
  }
  const foot = el('div', 'op-foot');
  append(foot,
    el('p', 'op-stat', fmtNum(n) + (n === 1 ? ' message' : ' messages')),
    el('p', 'op-stat', ch.days.size + (ch.days.size === 1 ? ' day' : ' days') + ' together'),
    el('p', 'op-stat', 'mostly in the ' + ch.peak));
  append(sec, top, cal, foot);
  return sec;
}

/* ------------------------------------------------------- chapter body */

function dayHeading(ctx, d, sceneNo, firstTs, count) {
  const h3 = el('h3', 'day');
  if (ctx.theme === 'playscript') {
    h3.appendChild(el('span', 'scene-no', 'Scene ' + sceneNo));
    h3.appendChild(el('span', 'scene-sep', ' \u00b7 '));
    const tod = partOfDay(new Date(firstTs).getHours());
    h3.appendChild(el('span', 'scene-when', weekdayDate(d) + ', ' + (tod === 'small hours' ? 'the small hours' : tod)));
    return h3;
  }
  if (ctx.theme === 'album') {
    h3.dataset.num = pad2(d.getDate());
    h3.dataset.count = count + (count === 1 ? ' message' : ' messages');
    h3.appendChild(el('span', 'day-week', WEEKDAYS[d.getDay()]));
    h3.appendChild(el('span', 'day-sep', ' '));
    h3.appendChild(el('span', 'day-date', d.getDate() + ' ' + MONTHS[d.getMonth()]));
    return h3;
  }
  h3.textContent = weekdayDate(d);
  return h3;
}

function interlude(ctx, ts) {
  const tod = partOfDay(new Date(ts).getHours());
  const p = el('p', 'interlude');
  const later = tod === 'small hours' ? 'Later, in the small hours' : 'Later that ' + tod;
  if (ctx.theme === 'playscript') p.textContent = later + '.';
  else p.appendChild(el('span', 'int-text', later));
  return p;
}

function buildChapterBody(ctx, ch) {
  const sec = el('section', 'chapter-body');
  let lastDay = null;
  let lastTs = null;
  let scene = 0;
  let holder = null; // keeps a heading together with the first block after it
  let first = true;
  const perDay = new Map();
  for (const m of ch.messages) perDay.set(dayKey(m.ts), (perDay.get(dayKey(m.ts)) || 0) + 1);

  const place = (node) => {
    if (holder && holder.childElementCount === 1) { holder.appendChild(node); holder = null; return; }
    holder = null;
    sec.appendChild(node);
  };

  for (const g of groupMessages(ch.messages)) {
    const ts = g.system ? g.system.ts : g.items[0].ts;
    const k = dayKey(ts);
    if (k !== lastDay) {
      scene++;
      holder = el('div', 'keep');
      holder.appendChild(dayHeading(ctx, dayDate(k), scene, ts, perDay.get(k)));
      sec.appendChild(holder);
      lastDay = k;
    } else if (lastTs && new Date(ts) - new Date(lastTs) >= 3 * 3600 * 1000) {
      holder = el('div', 'keep');
      holder.appendChild(interlude(ctx, ts));
      sec.appendChild(holder);
    }
    lastTs = g.system ? g.system.ts : g.last.ts;

    if (g.system) {
      place(buildSystem(ctx, g.system));
      continue;
    }
    const [head, ...rest] = buildGroup(ctx, g.items, first);
    // Under a heading, only the speaker line and first message are kept with
    // it; the rest of the group continues freely so pages fill properly.
    const tail = holder && holder.childElementCount === 1 ? splitTail(head) : null;
    place(head);
    if (tail) sec.appendChild(tail);
    for (const node of rest) sec.appendChild(node);
    first = false;
  }
  return sec;
}

function buildSystem(ctx, m) {
  const p = el('p', 'sysmsg');
  const text = m.text || (m.html ? sanitizeHtml(m.html).textContent : '');
  p.textContent = smartString(text.trim() || 'Something happened in the chat.');
  return p;
}

function buildGroup(ctx, msgs, opening) {
  const { theme, people } = ctx;
  const author = msgs[0].author;
  const name = author?.name || 'Unknown';
  const group = el('div', 'group');
  group.dataset.side = people.side(author);
  group.style.setProperty('--who', people.color(author));

  const speaker = el('div', 'speaker');
  if (theme === 'album') speaker.appendChild(initialBadge(name, people.color(author), 'who-badge badge'));
  speaker.appendChild(el('span', 'name', name));
  speaker.appendChild(el('span', 'time', clockTime(msgs[0].ts)));
  group.appendChild(speaker);

  for (const m of msgs) group.appendChild(buildMessage(ctx, m, name));
  // The speaker line never ends a page alone: it travels with the first message.
  // A long first message may break across pages, so only a short one is tied to it.
  const firstMsg = group.querySelector(':scope > .msg');
  const lead = el('div', 'lead');
  group.insertBefore(lead, speaker);
  lead.appendChild(speaker);
  if (firstMsg.textContent.length < 260 && !firstMsg.querySelector('pre, figure, .embed')) lead.appendChild(firstMsg);
  else lead.classList.add('loose');

  // A chapter's first words get a drop cap, never the speaker's name, and only
  // when the opening line is long enough to wrap around it.
  if (opening && theme === 'clothbound') {
    const p = group.querySelector('.msg-body > p:first-child');
    const text = p ? p.textContent.trim() : '';
    if (p && text.length >= 60 && /^[\p{L}]/u.test(text) && p.firstChild?.nodeType === Node.TEXT_NODE) p.classList.add('opening');
  }
  return theme === 'album' ? splitPlates(group) : [group];
}

function splitTail(group) {
  const after = [];
  for (let n = group.querySelector(':scope > .lead')?.nextSibling; n; n = n.nextSibling) after.push(n);
  if (!after.length) return null;
  const tail = group.cloneNode(false);
  tail.classList.add('tail');
  for (const n of after) tail.appendChild(n);
  return tail;
}

/** Album: photographs leave the speaker's column and run the full text width. */
function splitPlates(group) {
  const parts = [group];
  let cur = group;
  for (const msg of Array.from(group.querySelectorAll(':scope > .msg, :scope > .lead > .msg'))) {
    if (cur !== group) cur.appendChild(msg);
    const plates = Array.from(msg.children).filter((c) => c.matches('figure.plate'));
    if (!plates.length) continue;
    parts.push(...plates);
    cur = group.cloneNode(false);
    cur.classList.add('cont');
    parts.push(cur);
  }
  return parts.filter((p) => !(p.classList.contains('cont') && !p.childElementCount));
}

/** Wrap loose inline content in paragraphs; demote markdown headings. */
function normalizeBody(body) {
  const inlineTags = new Set(['STRONG', 'EM', 'U', 'S', 'DEL', 'CODE', 'BR', 'A', 'SPAN', 'IMG']);
  let run = null;
  for (const node of Array.from(body.childNodes)) {
    const inline = node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && inlineTags.has(node.tagName));
    if (inline) {
      if (!run) {
        if (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()) { node.remove(); continue; }
        run = el('p');
        body.insertBefore(run, node);
      }
      run.appendChild(node);
    } else {
      run = null;
    }
  }
  for (const h of Array.from(body.querySelectorAll('h1, h2, h3'))) {
    const p = el('p', 'md-' + h.tagName.toLowerCase());
    while (h.firstChild) p.appendChild(h.firstChild);
    h.replaceWith(p);
  }
  for (const p of Array.from(body.querySelectorAll('p'))) {
    while (p.lastChild && p.lastChild.nodeName === 'BR') p.lastChild.remove();
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  }
}

function buildMessage(ctx, m, name) {
  const wrap = el('div', 'msg');

  if (m.reply) {
    const r = el('p', 'reply');
    r.appendChild(el('span', 'reply-lead', ctx.theme === 'playscript' ? 'to ' : ctx.theme === 'album' ? '\u21b3 ' : 'replying to '));
    r.appendChild(el('span', 'reply-name', m.reply.author || 'someone'));
    if (m.reply.text) {
      const t = m.reply.text.length > 110 ? m.reply.text.slice(0, 108).trim() + '\u2026' : m.reply.text;
      r.appendChild(el('span', 'reply-text', smartString(t)));
    }
    wrap.appendChild(r);
  }

  const body = el('div', 'msg-body');
  body.appendChild(sanitizeHtml(m.html));
  normalizeBody(body);
  smartenTree(body);
  if (saidPattern) markSaid(body);

  for (const e of Array.from(body.querySelectorAll('img.emoji'))) {
    setImage(e, e.getAttribute('src'), () => failEmoji(e));
  }
  if (m.edited) {
    const lastP = [...body.children].reverse().find((c) => c.tagName === 'P');
    const mark = el('span', 'edited', 'edited');
    (lastP || body).appendChild(mark);
  }
  if (body.childNodes.length) wrap.appendChild(body);

  appendAttachments(ctx, wrap, m, name);
  for (const e of m.embeds || []) wrap.appendChild(buildEmbed(ctx, e, name));
  for (const st of m.stickers || []) wrap.appendChild(buildSticker(ctx, st, name));
  appendReactions(ctx, wrap, body, m.reactions || []);
  return wrap;
}

function direction(ctx, text) {
  return el('p', 'direction', text);
}

function appendAttachments(ctx, wrap, m, name) {
  const play = ctx.theme === 'playscript';
  for (const att of m.attachments || []) {
    if (att.type === 'image') {
      if (play) wrap.appendChild(direction(ctx, name + ' holds up a picture.'));
      wrap.appendChild(imageFigure(ctx, att, m, name));
    } else if (att.type === 'video') {
      const label = att.name || 'a video';
      wrap.appendChild(play
        ? direction(ctx, name + ' plays a video: ' + label + '.')
        : fileCard('att-video', label, 'Video'));
    } else if (att.type === 'file') {
      const size = fmtSize(att.size);
      const label = att.name || 'a file';
      wrap.appendChild(play
        ? direction(ctx, name + ' hands over a document: ' + label + (size ? ', ' + size : '') + '.')
        : fileCard('att-file', label, size));
    }
  }
}

/** A small card for a file or video: a document glyph, the name, the size. */
function fileCard(cls, name, detail) {
  const card = el('div', 'att ' + cls);
  const ext = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  card.appendChild(el('span', 'att-icon', cls === 'att-video' ? '\u25b6' : (ext || 'file').slice(0, 4).toUpperCase()));
  const text = el('span', 'att-text');
  text.appendChild(el('span', 'att-name', name));
  if (detail) text.appendChild(el('span', 'att-size', detail));
  card.appendChild(text);
  return card;
}

function figNote(ctx, kind, name) {
  return el('p', 'fig-note', (ctx.includeImages ? kind + ' not reproduced' : kind + ' omitted') + (name ? ': ' + name : ''));
}

function imageFigure(ctx, att, m, author) {
  const fig = el('figure', 'fig plate');
  if (!ctx.includeImages) {
    fig.classList.add('is-note');
    fig.appendChild(figNote(ctx, 'Image', att.name || 'image'));
    return fig;
  }
  const no = ++ctx.plates;
  const frame = el('div', 'plate-frame');
  const img = el('img');
  img.alt = att.name || 'image';
  if (att.width && att.height) {
    img.setAttribute('width', att.width);
    img.setAttribute('height', att.height);
    fig.style.setProperty('--ratio', (att.width / att.height).toFixed(4));
    if (att.width / att.height < 0.9) fig.classList.add('tall');
  }
  setImage(img, att.url, () => {
    fig.classList.add('is-note');
    fig.replaceChildren(figNote(ctx, 'Image', att.name || 'image'));
  });
  frame.appendChild(img);
  fig.appendChild(frame);
  const cap = el('figcaption');
  const label = ctx.theme === 'album' ? pad2(no) : ctx.theme === 'playscript' ? 'Fig. ' + no : 'Plate ' + roman(no);
  cap.appendChild(el('span', 'plate-no', label));
  cap.appendChild(el('span', 'plate-title', prettyFileName(att.name || 'image')));
  cap.appendChild(el('span', 'plate-meta', author + ', ' + shortDate(m.ts)));
  fig.appendChild(cap);
  return fig;
}

function buildEmbed(ctx, e, name) {
  const card = el('div', 'embed');
  const hex = colorHex(e.color);
  if (hex) card.style.setProperty('--embed-color', hex);
  if (ctx.theme === 'playscript') {
    card.appendChild(el('p', 'direction embed-direction', name + ' passes over a clipping' + (e.provider ? ' from ' + e.provider : '') + '.'));
  } else if (e.provider) {
    card.appendChild(el('p', 'embed-provider', e.provider));
  }
  if (e.author) card.appendChild(el('p', 'embed-author', e.author));
  if (e.title) {
    const t = el('p', 'embed-title');
    if (e.url && LINK_HREF_RE.test(e.url)) {
      const a = el('a', null, smartString(e.title));
      a.href = e.url;
      t.appendChild(a);
    } else {
      t.textContent = smartString(e.title);
    }
    card.appendChild(t);
  }
  if (e.description) card.appendChild(el('p', 'embed-desc', smartString(e.description)));
  if (e.image) {
    if (ctx.includeImages) {
      const img = el('img', 'embed-img');
      img.alt = e.title || 'embed image';
      setImage(img, e.image, () => img.replaceWith(el('p', 'fig-note', 'Image not reproduced')));
      card.appendChild(img);
    } else {
      card.appendChild(el('p', 'fig-note', 'Image omitted'));
    }
  }
  return card;
}

function buildSticker(ctx, st, name) {
  const fig = el('figure', 'fig sticker');
  const label = st.name || 'sticker';
  if (!ctx.includeImages) {
    fig.classList.add('is-note');
    fig.appendChild(figNote(ctx, 'Sticker', label));
    return fig;
  }
  const img = el('img', 'sticker-img');
  img.alt = label;
  setImage(img, st.url, () => {
    fig.classList.add('is-note');
    fig.replaceChildren(figNote(ctx, 'Sticker', label));
  });
  fig.appendChild(img);
  fig.appendChild(el('figcaption', null, ctx.theme === 'playscript' ? name + ' sends a sticker: ' + label + '.' : label));
  return fig;
}

function appendReactions(ctx, wrap, body, reactions) {
  if (!reactions.length) return;
  const row = el('p', 'reactions');
  for (const r of reactions) {
    const span = el('span', 'rxn');
    if (r.emojiUrl) {
      const img = el('img', 'rxn-img');
      img.alt = '';
      setImage(img, r.emojiUrl, () => img.replaceWith(el('span', 'rxn-glyph rxn-missing', '\u2726')));
      span.appendChild(img);
    } else {
      span.appendChild(el('span', 'rxn-glyph', r.emoji || '\u2726'));
    }
    span.appendChild(el('span', 'rxn-count', String(r.count ?? 1)));
    row.appendChild(span);
  }
  wrap.appendChild(row);
}

/* --------------------------------------------------------------- stats */

function buildStats(ctx) {
  const { record, stats, theme } = ctx;
  const sec = el('section', 'back numbers');
  sec.id = 'numbers';
  const head = el('div', 'num-head');
  if (theme === 'clothbound') head.appendChild(el('p', 'num-kicker', 'Appendix'));
  if (theme === 'playscript') head.appendChild(el('p', 'num-kicker', 'Programme notes'));
  head.appendChild(el('h2', 'front-title', 'By the Numbers'));
  sec.appendChild(head);

  const figs = el('div', 'num-figures');
  const fig = (value, label, sub) => {
    const f = el('div', 'num-fig');
    f.appendChild(el('span', 'num-value', value));
    f.appendChild(el('span', 'num-label', label));
    if (sub) f.appendChild(el('span', 'num-sub', sub));
    figs.appendChild(f);
  };
  fig(fmtNum(stats.total), 'messages', fmtNum(stats.totalWords) + ' words');
  fig(fmtNum(stats.activeDays), stats.activeDays === 1 ? 'day talking' : 'days talking',
    stats.span ? 'across ' + fmtNum(stats.span) + (stats.span === 1 ? ' day' : ' days') : null);
  if (stats.busiest) fig(fmtNum(stats.busiest.count), 'on the busiest day', weekdayDate(dayDate(stats.busiest.day)) + ' ' + stats.busiest.day.slice(0, 4));
  if (stats.streak.length) {
    fig(fmtNum(stats.streak.length), stats.streak.length === 1 ? 'day in a row' : 'days in a row',
      stats.streak.length > 1
        ? shortDate(stats.streak.from) + ' \u2013 ' + shortDate(stats.streak.to)
        : shortDate(stats.streak.from));
  }
  sec.appendChild(figs);

  const cols = el('div', 'num-cols');
  const block = (title) => {
    const b = el('div', 'num-block');
    b.appendChild(el('h4', 'num-title', title));
    cols.appendChild(b);
    return b;
  };

  const who = block(theme === 'playscript' ? 'Lines spoken' : 'Messages by person');
  const people = record.participants.slice(0, 6);
  const maxCount = Math.max(1, ...people.map((p) => p.count || 0));
  const total = Math.max(1, record.participants.reduce((a, p) => a + (p.count || 0), 0));
  for (const p of people) {
    const r = el('div', 'num-person');
    r.style.setProperty('--who', ctx.people.color(p));
    r.style.setProperty('--w', ((p.count || 0) / maxCount * 100).toFixed(1) + '%');
    if (theme === 'album') r.appendChild(avatar(ctx, p, 'mini-face'));
    r.appendChild(el('span', 'np-name', p.name));
    r.appendChild(el('span', 'np-count', fmtNum(p.count || 0)));
    r.appendChild(el('span', 'np-share', Math.round((p.count || 0) / total * 100) + '%'));
    r.appendChild(el('span', 'np-bar'));
    who.appendChild(r);
  }
  if (record.participants.length > people.length) {
    who.appendChild(el('p', 'num-more', 'and ' + (record.participants.length - people.length) + ' more'));
  }

  const hours = block('Hour by hour');
  const chart = el('div', 'hours');
  const peak = Math.max(1, ...stats.hours);
  stats.hours.forEach((v, h) => {
    const bar = el('span', 'hour');
    bar.style.setProperty('--h', (v / peak * 100).toFixed(1) + '%');
    if (h === stats.peakHour) bar.classList.add('peak');
    chart.appendChild(bar);
  });
  hours.appendChild(chart);
  const axis = el('div', 'hours-axis');
  for (const t of ['00', '06', '12', '18', '24']) axis.appendChild(el('span', null, t));
  hours.appendChild(axis);
  hours.appendChild(el('p', 'num-note', 'Busiest around ' + pad2(stats.peakHour) + ':00, in the ' + partOfDay(stats.peakHour) + '.'));

  if (stats.words.length) {
    const wb = block('Most used words');
    const ol = el('ol', 'num-words');
    for (const [w, n] of stats.words) {
      const li = el('li');
      li.appendChild(el('span', 'nw-word', w));
      li.appendChild(el('span', 'nw-count', fmtNum(n)));
      ol.appendChild(li);
    }
    wb.appendChild(ol);
  }

  const emo = stats.emoji.length ? stats.emoji : stats.reactions;
  if (emo.length) {
    const eb = block(stats.emoji.length ? 'Favourite emoji' : 'Favourite reactions');
    const ul = el('ul', 'num-emoji');
    for (const [e, n] of emo) {
      const li = el('li');
      li.appendChild(el('span', e.startsWith(':') ? 'ne-glyph ne-custom' : 'ne-glyph', e));
      li.appendChild(el('span', 'ne-count', '\u00d7' + fmtNum(n)));
      ul.appendChild(li);
    }
    eb.appendChild(ul);
    if (stats.emoji.length && stats.reactions.length) {
      const top = stats.reactions[0];
      eb.appendChild(el('p', 'num-note', 'Most given reaction: ' + top[0] + ' \u00d7' + fmtNum(top[1]) + '.'));
    }
  }
  sec.appendChild(cols);

  if (stats.longest && stats.longest.words > 12) {
    sec.appendChild(el('p', 'num-footnote', 'The longest message ran to ' + fmtNum(stats.longest.words) + ' words, from '
      + (stats.longest.m.author?.name || 'someone') + ' on ' + longDate(stats.longest.m.ts) + '.'));
  }
  return sec;
}

/* ------------------------------------------------------------- closing */

function buildFin(ctx) {
  const { record, theme, meta } = ctx;
  const sec = el('section', 'fin');
  sec.id = 'fin';
  const msgs = record.messages;
  const last = [...msgs].reverse().find((m) => !m.system && plainText(m));
  const lastLine = () => {
    if (!last) return null;
    const box = el('div', 'fin-last');
    box.appendChild(el('p', 'fin-label', theme === 'playscript' ? 'The last line' : 'The last word'));
    let t = plainText(last);
    if (t.length > 220) t = t.slice(0, 218).trim() + '\u2026';
    box.appendChild(el('p', 'fin-quote', smartString(t)));
    box.appendChild(el('p', 'fin-attr', (last.author?.name || 'Unknown') + ', ' + longDate(last.ts)));
    return box;
  };

  if (theme === 'clothbound') {
    append(sec, el('p', 'fin-orn', '\u2767'), el('h2', 'fin-word', 'The End'), lastLine());
    return sec;
  }
  if (theme === 'playscript') {
    append(sec,
      el('div', 'fin-rule'),
      el('h2', 'fin-word', 'Curtain'),
      el('p', 'fin-sub', 'End of play'),
      el('div', 'fin-rule'),
      lastLine(),
      meta.first ? el('p', 'fin-history', 'First performed on Discord between ' + longDate(meta.first.toISOString())
        + ' and ' + longDate(meta.last.toISOString()) + '.') : null);
    return sec;
  }
  append(sec,
    el('p', 'fin-kicker', meta.title),
    el('h2', 'fin-word', 'Until next time.'),
    lastLine(),
    el('p', 'fin-made', 'Made with Discord Book'));
  return sec;
}

function buildBoard(ctx) {
  const { record, meta } = ctx;
  const sec = el('section', 'board');
  sec.id = 'back-cover';
  const frame = el('div', 'board-frame');
  const q = pickQuote(record.messages, { min: 30, max: 160 });
  if (q) {
    frame.appendChild(el('p', 'board-quote', smartString('\u201c' + plainText(q) + '\u201d')));
    frame.appendChild(el('p', 'board-attr', q.author?.name || 'Unknown'));
  }
  frame.appendChild(el('p', 'board-blurb', words(record.messages.length) === fmtNum(record.messages.length)
    ? fmtNum(record.messages.length) + ' messages, ' + meta.dateRange + '.'
    : cap(words(record.messages.length)) + ' messages, ' + meta.dateRange + '.'));
  frame.appendChild(el('div', 'board-device', '\u2767'));
  frame.appendChild(el('p', 'board-house', 'Discord Book'));
  sec.appendChild(frame);
  return sec;
}

/* ------------------------------------------------- injected page rules */

let injectedStyle = null;
let saidPattern = null;

function phrasePattern(phrases) {
  const list = (phrases || []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return null;
  const body = list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['\u2019]/g, "['\u2019]").replace(/["\u201c\u201d]/g, '["\u201c\u201d]')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'giu');
}

function markSaid(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('code, pre, mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const matches = [...text.matchAll(saidPattern)];
    if (!matches.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const match of matches) {
      frag.appendChild(document.createTextNode(text.slice(at, match.index)));
      frag.appendChild(el('mark', 'said', match[0]));
      at = match.index + match[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(at)));
    node.replaceWith(frag);
  }
}

function injectPageRules(ctx) {
  const { theme, chapters, meta } = ctx;
  const t = THEME[theme];
  const [w, h] = t.page;
  const { top, bottom, inner, outer } = t.margin;
  const title = cssEsc(meta.headerTitle);
  const paper = t.paper;
  const muted = t.muted;
  const head = t.head + 'color:' + muted + ';';
  const folio = t.folio + 'color:' + muted + ';';
  const verso = top + 'mm ' + inner + 'mm ' + bottom + 'mm ' + outer + 'mm';
  const recto = top + 'mm ' + outer + 'mm ' + bottom + 'mm ' + inner + 'mm';
  const topBox = 'vertical-align:bottom;padding-bottom:' + (theme === 'album' ? 6 : 7) + 'mm;';
  const botBox = 'vertical-align:top;padding-top:' + (theme === 'album' ? 7.5 : 8) + 'mm;';

  let css = '@page { size: ' + w + 'mm ' + h + 'mm; margin: ' + verso + '; background: ' + paper + '; }\n'
    + '@page :left { margin: ' + verso + '; }\n'
    + '@page :right { margin: ' + recto + '; }\n'
    + '@page cover { margin: 0; background: ' + (theme === 'playscript' ? paper : t.board) + '; }\n'
    + '@page board { margin: 0; background: ' + t.board + '; }\n'
    + '@page endpaper { margin: 0; background: #e6d9bd; }\n'
    + '@page front:left { margin: ' + verso + '; }\n'
    + '@page front:right { margin: ' + recto + '; }\n'
    + (theme === 'album'
      ? '@page fin { margin: 0; background: ' + t.board + '; }\n'
      : '@page fin:left { margin: ' + verso + '; }\n@page fin:right { margin: ' + recto + '; }\n')
    + '@page back:left { margin: ' + verso + '; @bottom-left { content: counter(page); ' + folio + botBox + ' } }\n'
    + '@page back:right { margin: ' + recto + '; @bottom-right { content: counter(page); ' + folio + botBox + ' } }\n';

  for (const ch of chapters) {
    const n = ch.num;
    const chapLabel = theme === 'playscript'
      ? 'Act ' + roman(n) + '  \u00b7  ' + ch.label
      : theme === 'album' ? ch.label : ch.label;
    const chap = cssEsc(chapLabel);
    if (theme === 'album') {
      const colors = THEME.album.chapterColors;
      css += '@page ch' + n + ' { margin: 0; background: ' + colors[(n - 1) % colors.length] + '; }\n'
        + '@page ch' + n + 'b:left { margin: ' + verso + ';\n'
        + '  @bottom-left { content: counter(page) "\u2003\u2003' + title + '"; ' + head + botBox + ' text-align: left; }\n}\n'
        + '@page ch' + n + 'b:right { margin: ' + recto + ';\n'
        + '  @bottom-right { content: "' + chap + '\u2003\u2003" counter(page); ' + head + botBox + ' text-align: right; }\n}\n';
    } else if (theme === 'playscript') {
      css += '@page ch' + n + ':left { margin: ' + verso + '; }\n@page ch' + n + ':right { margin: ' + recto + '; }\n'
        + '@page ch' + n + 'b:left { margin: ' + verso + ';\n'
        + '  @top-left { content: counter(page) "\u2003\u2003' + title + '"; ' + head + topBox + ' }\n}\n'
        + '@page ch' + n + 'b:right { margin: ' + recto + ';\n'
        + '  @top-right { content: "' + chap + '\u2003\u2003" counter(page); ' + head + topBox + ' }\n}\n';
    } else {
      css += '@page ch' + n + ':left { margin: ' + verso + '; @bottom-center { content: counter(page); ' + folio + botBox + ' } }\n'
        + '@page ch' + n + ':right { margin: ' + recto + '; @bottom-center { content: counter(page); ' + folio + botBox + ' } }\n'
        + '@page ch' + n + 'b:left { margin: ' + verso + ';\n'
        + '  @top-center { content: "' + title + '"; ' + head + topBox + ' }\n'
        + '  @bottom-center { content: counter(page); ' + folio + botBox + ' }\n}\n'
        + '@page ch' + n + 'b:right { margin: ' + recto + ';\n'
        + '  @top-center { content: "' + chap + '"; ' + head + topBox + ' }\n'
        + '  @bottom-center { content: counter(page); ' + folio + botBox + ' }\n}\n';
    }
  }
  if (injectedStyle) injectedStyle.remove();
  injectedStyle = document.createElement('style');
  injectedStyle.textContent = css;
  document.head.appendChild(injectedStyle);
  document.documentElement.style.setProperty('--page-w', w + 'mm');
  document.documentElement.style.setProperty('--page-h', h + 'mm');
  document.documentElement.style.setProperty('--m-top', top + 'mm');
  document.documentElement.style.setProperty('--m-bottom', bottom + 'mm');
}

/* ----------------------------------------------------------------- main */

export async function renderBook(record, root, { includeImages = true, theme } = {}) {
  if (!record || !Array.isArray(record.messages)) throw new TypeError('renderBook: record with messages[] required');
  if (!(root instanceof HTMLElement)) throw new TypeError('renderBook: root element required');

  theme = resolveTheme(theme);
  record = {
    ...record,
    chat: record.chat || { kind: 'dm', title: 'Discord' },
    participants: Array.isArray(record.participants) ? record.participants.filter((p) => p && p.name) : [],
  };

  watchedImages.clear();
  saidPattern = record.mode === 'pair' ? phrasePattern(record.filter?.phrases) : null;
  document.documentElement.lang = 'en';
  for (const node of [document.documentElement, document.body]) {
    for (const t of THEMES) node.classList.toggle('theme-' + t, t === theme);
    node.classList.remove('theme-classic', 'theme-midnight');
  }
  root.className = 'book theme-' + theme;

  const meta = deriveMeta(record);
  document.title = meta.title;

  const chapters = chapterize(record);
  const ctx = {
    record,
    meta,
    theme,
    includeImages,
    chapters,
    plates: 0,
    people: makePeople(record, meta, theme),
    stats: computeStats(record),
  };

  root.replaceChildren();
  root.appendChild(buildCover(ctx));
  if (theme === 'clothbound') {
    root.appendChild(buildEndpaper(ctx, true));
    root.appendChild(buildHalfTitle(ctx));
    root.appendChild(buildFrontis(ctx));
    root.appendChild(buildTitlePage(ctx));
  }
  root.appendChild(buildColophon(ctx));
  if (theme === 'playscript') root.appendChild(buildCast(ctx));
  root.appendChild(buildToc(ctx));
  // A short contents page keeps chapter one on a right-hand page.
  if (theme === 'clothbound' && chapters.length <= 14) root.appendChild(el('section', 'front blank'));
  for (const ch of chapters) {
    const open = buildOpener(ctx, ch);
    open.style.page = 'ch' + ch.num;
    root.appendChild(open);
    const body = buildChapterBody(ctx, ch);
    body.style.page = 'ch' + ch.num + 'b';
    root.appendChild(body);
  }
  root.appendChild(buildStats(ctx));
  root.appendChild(buildFin(ctx));
  if (theme === 'clothbound') {
    root.appendChild(buildEndpaper(ctx, false));
    root.appendChild(buildBoard(ctx));
  }

  injectPageRules(ctx);

  await finishImages(20000);
  await (document.fonts ? document.fonts.ready : Promise.resolve());
}
