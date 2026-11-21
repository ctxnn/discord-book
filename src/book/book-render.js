/* Discord Book renderer: turns an ExportRecord into a typeset book.
 * ES module, no dependencies. Everything is CSP-safe: no inline scripts,
 * no eval, no remote resources; the only innerHTML usage is record html
 * fields passed through the whitelist sanitizer below (defense in depth).
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

/* ----------------------------------------------------------- formatting */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function roman(n) {
  const pairs = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of pairs) while (n >= v) { out += s; n -= v; }
  return out;
}

function ordinal(n) {
  const words = ['zero', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
    'seventh', 'eighth', 'ninth', 'tenth'];
  return words[n] ?? `${n}th`;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function dayHeading(date) {
  return `${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function monthLabel(y, m) {
  return `${MONTHS[m]} ${y}`;
}

function longDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clockTime(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function fmtSize(n) {
  if (n == null) return null;
  if (typeof n === 'string') return n;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ----------------------------------------------------------- derivations */

function deriveMeta(record) {
  const { chat, mode, pair, participants } = record;
  const names = (pair && pair.length === 2 && mode === 'pair')
    ? pair.slice()
    : participants.map((p) => p.name);

  let title, subtitle;
  if (mode === 'pair') {
    title = `${cap(names[0] || 'Unknown')} & ${cap(names[1] || 'Unknown')}`;
    subtitle = `in ${chat.title}${chat.serverName ? ` · ${chat.serverName}` : ''}`;
  } else if (chat.kind === 'channel') {
    title = chat.title;
    subtitle = chat.serverName || null;
  } else {
    title = `${cap(names[0] || 'Unknown')} & me`;
    subtitle = chat.kind === 'group' ? 'a group conversation' : null;
  }

  const msgs = record.messages || [];
  const first = msgs.length ? new Date(msgs[0].ts) : null;
  const last = msgs.length ? new Date(msgs[msgs.length - 1].ts) : null;
  const sameMonth = first && last && first.getUTCFullYear() === last.getUTCFullYear()
    && first.getUTCMonth() === last.getUTCMonth();
  const dateRange = first && !sameMonth
    ? `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()} – ${MONTHS[last.getUTCMonth()]} ${last.getUTCFullYear()}`
    : (first ? `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}` : '');

  return { title, subtitle, dateRange, headerTitle: record.mode === 'pair' ? `${title} in ${chat.title}` : title };
}

const PALETTES = {
  classic: ['#7d3428', '#3e5c46', '#41547c', '#7a5a24', '#5b3a6e', '#28646b', '#7c3b58'],
  midnight: ['#e3b559', '#e59a9f', '#a8c4a0', '#9cc0e8', '#c5b3e6', '#8fc7c0', '#e8b48f'],
};

function colorFor(record, author) {
  const palette = document.body.classList.contains('theme-midnight') ? PALETTES.midnight : PALETTES.classic;
  if (!author) return palette[palette.length - 1];
  const idx = record.participants.findIndex((p) => (author.id ? p.id === author.id : p.name === author.name));
  return palette[idx >= 0 ? idx % palette.length
    : Math.abs([...(author.name || '?')].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % palette.length];
}

/* ----------------------------------------------------------------- dom */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function cssEsc(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function colorHex(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/* --------------------------------------------------------------- cover */

function buildCover(record, meta, root) {
  const sec = el('section', 'cover');
  sec.id = 'cover';
  const frame = el('div', 'cover-frame');

  frame.appendChild(el('div', 'cover-orn top', '❦'));

  const head = el('div', 'cover-heading');
  head.appendChild(el('p', 'cover-kicker', 'A Discord Book'));
  head.appendChild(el('h1', 'book-title', meta.title));
  if (meta.subtitle) head.appendChild(el('p', 'cover-sub', meta.subtitle));
  if (meta.dateRange) head.appendChild(el('p', 'cover-dates', meta.dateRange));
  frame.appendChild(head);

  const mid = el('div', 'cover-mid');
  mid.appendChild(el('hr', 'cover-rule'));
  const people = el('div', 'cover-people');
  for (const p of record.participants.slice(0, 6)) {
    const person = el('div', 'cover-person');
    if (p.avatar) {
      const img = el('img', 'cover-avatar');
      img.alt = p.name;
      setImage(img, p.avatar, () => img.replaceWith(initialBadge(p.name, colorFor(record, p))));
      person.appendChild(img);
    } else {
      person.appendChild(initialBadge(p.name, colorFor(record, p)));
    }
    person.appendChild(el('span', 'cover-person-name', p.name));
    people.appendChild(person);
  }
  mid.appendChild(people);
  mid.appendChild(el('p', 'cover-count', `${record.messages.length} messages`));
  frame.appendChild(mid);

  frame.appendChild(el('div', 'cover-orn bottom', '❧'));
  sec.appendChild(frame);
  return sec;
}

function initialBadge(name, color) {
  const span = el('span', 'cover-initial', (name || '?').trim().charAt(0).toUpperCase());
  if (color) span.style.background = color;
  return span;
}

/* ------------------------------------------------------------ colophon */

function buildColophon(record, meta) {
  const sec = el('section', 'front colophon');
  sec.id = 'colophon';
  sec.appendChild(el('h2', 'front-title', 'About this Book'));
  sec.appendChild(el('hr', 'front-rule'));

  const body = el('div', 'colophon-body');
  const row = (key, val) => {
    const r = el('div', 'colophon-row');
    r.appendChild(el('span', 'colophon-key', key));
    const v = el('span', 'colophon-val');
    if (typeof val === 'string') v.textContent = val;
    else v.appendChild(val);
    r.appendChild(v);
    return r;
  };

  body.appendChild(row('Edition', `${cap(ordinal(record.version))} edition`));
  body.appendChild(row('Exported', longDate(record.createdAt)));

  let source;
  if (record.chat.kind === 'channel') {
    source = `${record.chat.title}${record.chat.serverName ? ` in ${record.chat.serverName}` : ''}`;
  } else if (record.chat.kind === 'group') {
    source = 'A group direct message';
  } else {
    source = 'A direct message';
  }
  if (record.mode === 'pair') source += ` — the conversation between ${record.pair.map(cap).join(' and ')}`;
  body.appendChild(row('Source', source));

  body.appendChild(row('Messages', String(record.messages.length)));

  const parts = el('span');
  record.participants.forEach((p, i) => {
    if (i) parts.appendChild(document.createTextNode(', '));
    parts.appendChild(el('span', null, `${p.name} (${p.count ?? '?'})`));
  });
  body.appendChild(row('Participants', parts));

  body.appendChild(row('Scope', record.complete
    ? 'The complete history of this conversation.'
    : 'This edition begins partway through the history; earlier messages were not collected.'));
  body.appendChild(row('Mode', record.mode === 'pair'
    ? 'Pair mode: only the exchanges between the two named people.'
    : 'Full chat: every message in the channel or conversation.'));

  sec.appendChild(body);
  sec.appendChild(el('p', 'colophon-note',
    'Set in EB Garamond and Cormorant Garamond. Page margins are mirrored as in a bound book; odd pages carry the chapter, even pages the title.'));
  const made = el('p', 'colophon-made', 'Made with ');
  made.appendChild(Object.assign(el('b'), { textContent: 'Discord Book' }));
  sec.appendChild(made);
  return sec;
}

/* ------------------------------------------------------------------ toc */

function buildToc(chapters) {
  const sec = el('nav', 'front toc');
  sec.id = 'contents';
  sec.appendChild(el('h2', 'front-title', 'Contents'));
  sec.appendChild(el('hr', 'front-rule'));
  const list = el('ul', 'toc-list');
  for (const ch of chapters) {
    const li = el('li', 'toc-entry');
    const a = el('a');
    a.href = `#ch-${ch.num}`;
    a.appendChild(el('span', 'toc-title', `Chapter ${roman(ch.num)}`));
    a.appendChild(el('span', 'toc-month', ` · ${ch.label}`));
    a.appendChild(el('span', 'toc-dots'));
    a.appendChild(el('span', 'toc-meta', `${ch.dayRange} · ${ch.count} messages`));
    li.appendChild(a);
    list.appendChild(li);
  }
  sec.appendChild(list);
  return sec;
}

/* ------------------------------------------------------------- chapters */

function chapterize(record) {
  const byMonth = new Map();
  for (const m of record.messages) {
    const d = new Date(m.ts);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(m);
  }
  return [...byMonth.entries()].map(([key, msgs], i) => {
    const [y, m] = key.split('-').map(Number);
    const firstDay = new Date(msgs[0].ts).getUTCDate();
    const lastDay = new Date(msgs[msgs.length - 1].ts).getUTCDate();
    return {
      num: i + 1,
      year: y, month: m,
      label: monthLabel(y, m),
      dayRange: `${firstDay}${lastDay !== firstDay ? ` – ${lastDay}` : ''} ${MONTHS[m].slice(0, 3)}`,
      count: msgs.length,
      messages: msgs,
    };
  });
}

function buildChapterOpen(ch) {
  const sec = el('section', 'chapter');
  sec.id = `ch-${ch.num}`;
  sec.appendChild(el('p', 'chapter-num', `Chapter ${roman(ch.num)}`));
  const h2 = el('h2', 'chapter-title', ch.label);
  sec.appendChild(h2);
  sec.appendChild(el('p', 'chapter-orn', '❦'));
  sec.appendChild(el('p', 'chapter-meta', `${ch.count} messages · ${ch.dayRange}`));
  return sec;
}

/** Consecutive non-system messages by the same author within 7 min group up. */
function groupMessages(messages) {
  const groups = [];
  let cur = null;
  for (const m of messages) {
    if (m.system) { groups.push({ system: m }); cur = null; continue; }
    const keyOf = (x) => (x.author ? (x.author.id || x.author.name || '@anon') : '@anon');
    if (cur) {
      const dt = new Date(m.ts) - new Date(cur.last.ts);
      const same = keyOf(m) === keyOf(cur.last);
      if (same && dt >= 0 && dt <= 7 * 60 * 1000) { cur.items.push(m); cur.last = m; continue; }
    }
    cur = { items: [m], last: m };
    groups.push(cur);
  }
  return groups;
}

function buildChapterBody(record, ch, opts) {
  const sec = el('section', 'chapter-body');
  let lastDayKey = null;
  let firstGroupOfChapter = true;
  let dayBlock = null; // wraps a day heading + its first group so they never split

  for (const g of groupMessages(ch.messages)) {
    if (g.system) {
      sec.appendChild(el('p', 'sysmsg', g.system.text || g.system.html || ''));
      continue;
    }
    const dayKey = g.items[0].ts.slice(0, 10);
    if (dayKey !== lastDayKey) {
      const d = new Date(g.items[0].ts);
      dayBlock = el('div', 'day-block');
      dayBlock.appendChild(el('h3', 'day', dayHeading(d)));
      sec.appendChild(dayBlock);
      lastDayKey = dayKey;
    }
    const group = buildGroup(record, g.items, { dropcap: firstGroupOfChapter, includeImages: opts.includeImages });
    (dayBlock && dayBlock.children.length === 1 ? dayBlock : sec).appendChild(group);
    firstGroupOfChapter = false;
  }
  return sec;
}

function buildGroup(record, msgs, { dropcap, includeImages }) {
  const group = el('div', 'msg-group');
  const head = el('div', 'msg-head');
  const author = el('span', 'author', msgs[0].author?.name || 'Unknown');
  author.style.color = colorFor(record, msgs[0].author);
  head.appendChild(author);
  head.appendChild(el('span', 'time', clockTime(msgs[0].ts)));
  group.appendChild(head);

  msgs.forEach((m, i) => group.appendChild(buildMessage(record, m, {
    includeImages,
    dropcap: dropcap && i === 0,
  })));
  return group;
}

function buildMessage(record, m, { includeImages, dropcap }) {
  const wrap = el('div', 'msg');

  if (m.reply) {
    const r = el('p', 'reply');
    r.appendChild(document.createTextNode('↳ replying to '));
    r.appendChild(el('span', 'reply-name', m.reply.author || 'someone'));
    if (m.reply.text) r.appendChild(document.createTextNode(`: ${m.reply.text}`));
    wrap.appendChild(r);
  }

  const body = el('div', 'msg-body');
  body.appendChild(sanitizeHtml(m.html));

  // inline custom emoji: a failed one becomes its alt text, never a broken icon
  for (const e of Array.from(body.querySelectorAll('img.emoji'))) {
    setImage(e, e.getAttribute('src'), () => failEmoji(e));
  }

  // drop cap on the chapter's first paragraph, only when it opens with a letter
  if (dropcap) {
    const first = body.firstElementChild;
    const startsWithEmoji = first && first.firstChild && first.firstChild.nodeType === Node.ELEMENT_NODE
      && first.firstChild.tagName === 'IMG';
    const ch = first && first.tagName === 'P' && !startsWithEmoji
      ? (first.textContent.trim().match(/^[\p{L}]/u) || [])[0] : null;
    if (ch) first.classList.add('dropcap');
  }

  if (m.edited) {
    const lastP = [...body.children].reverse().find((c) => c.tagName === 'P');
    const mark = el('span', 'edited', '(edited)');
    if (lastP) lastP.appendChild(mark);
    else body.appendChild(mark);
  }
  wrap.appendChild(body);

  appendAttachments(wrap, m, includeImages);
  for (const e of m.embeds || []) wrap.appendChild(buildEmbed(e, includeImages));
  for (const st of m.stickers || []) wrap.appendChild(buildSticker(st, includeImages));
  appendReactions(wrap, m.reactions || []);
  return wrap;
}

function appendAttachments(wrap, m, includeImages) {
  for (const att of m.attachments || []) {
    if (att.type === 'image') {
      wrap.appendChild(imageFigure(att, includeImages, 'fig'));
    } else if (att.type === 'video') {
      const note = el('p', 'fig-note', `▶ video: ${att.name || 'video'}`);
      wrap.appendChild(note);
    } else if (att.type === 'file') {
      const f = el('p', 'att-file', `📎 ${att.name || 'file'}`);
      const size = fmtSize(att.size);
      if (size) f.appendChild(el('span', 'file-size', ` (${size})`));
      wrap.appendChild(f);
    }
  }
}

function imageFigure(att, includeImages, cls) {
  const fig = el('figure', cls);
  if (!includeImages) {
    fig.appendChild(el('p', 'fig-note', `[image: ${att.name || 'image'}]`));
    return fig;
  }
  const img = el('img');
  img.alt = att.name || 'image';
  if (att.width) img.setAttribute('width', att.width);
  if (att.height) img.setAttribute('height', att.height);
  setImage(img, att.url, () => {
    const note = el('p', 'fig-note', `[image: ${att.name || 'image'}]`);
    fig.replaceChildren(note);
  });
  fig.appendChild(img);
  if (att.name) fig.appendChild(el('figcaption', null, att.name));
  return fig;
}

function buildEmbed(e, includeImages) {
  const card = el('div', 'embed');
  const hex = colorHex(e.color);
  if (hex) card.style.setProperty('--embed-color', hex);
  if (e.provider) card.appendChild(el('p', 'embed-provider', e.provider));
  if (e.author) card.appendChild(el('p', 'embed-author', e.author));
  if (e.title) {
    const t = el('p', 'embed-title');
    if (e.url && LINK_HREF_RE.test(e.url)) {
      const a = el('a', null, e.title);
      a.href = e.url;
      t.appendChild(a);
    } else {
      t.textContent = e.title;
    }
    card.appendChild(t);
  }
  if (e.description) card.appendChild(el('p', 'embed-desc', e.description));
  if (e.image) {
    if (includeImages) {
      const img = el('img', 'embed-img');
      img.alt = 'embed image';
      setImage(img, e.image, () => img.remove());
      card.appendChild(img);
    } else {
      card.appendChild(el('p', 'fig-note', '[embed image omitted]'));
    }
  }
  return card;
}

function buildSticker(st, includeImages) {
  const fig = el('figure', 'fig sticker');
  if (!includeImages) {
    fig.appendChild(el('p', 'fig-note', `[sticker: ${st.name || 'sticker'}]`));
    return fig;
  }
  const img = el('img', 'sticker-img');
  img.alt = st.name || 'sticker';
  setImage(img, st.url, () => {
    fig.replaceChildren(el('p', 'fig-note', `[sticker: ${st.name || 'sticker'}]`));
  });
  fig.appendChild(img);
  fig.appendChild(el('figcaption', null, st.name || 'sticker'));
  return fig;
}

function appendReactions(wrap, reactions) {
  if (!reactions.length) return;
  const row = el('p', 'reactions');
  reactions.forEach((r, i) => {
    if (i) row.appendChild(el('span', 'sep', '·'));
    const span = el('span', 'rxn');
    if (r.emojiUrl) {
      const img = el('img', 'rxn-emoji-img');
      img.alt = '❔';
      setImage(img, r.emojiUrl, () => img.replaceWith(document.createTextNode('✦')));
      span.appendChild(img);
    } else {
      span.appendChild(document.createTextNode(r.emoji || '✦'));
    }
    span.appendChild(document.createTextNode(` ${r.count}`));
    row.appendChild(span);
  });
  wrap.appendChild(row);
}

/* ------------------------------------------------------ broken images */

const watchedImages = new Map(); // img -> onFail

/** Set src with failure handling: onFail runs on error, on a failure that
 *  happened before the listener existed (complete && !naturalWidth), or when
 *  the 20 s cap in finishImages() hits while the image is still pending. */
function setImage(img, url, onFail) {
  watchedImages.set(img, onFail);
  img.addEventListener('error', () => {
    if (watchedImages.delete(img) && onFail) onFail();
  }, { once: true });
  img.src = url;
  if (img.complete && img.naturalWidth === 0) {
    if (watchedImages.delete(img) && onFail) onFail();
  } else if (img.complete) {
    watchedImages.delete(img);
  }
}

function failEmoji(img) {
  img.replaceWith(el('span', 'emoji-fallback', img.getAttribute('alt') || '✦'));
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
        else img.classList.add('img-failed');
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

/* ------------------------------------------------- injected page rules */

function injectPageRules(record, meta, chapters) {
  const style = document.createElement('style');
  const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#8d8271';
  const title = cssEsc(meta.headerTitle);
  const headStyle = 'font-family:"EB Garamond",Georgia,serif;font-size:8pt;'
    + 'font-variant:small-caps;letter-spacing:0.16em;'
    + 'margin:-2mm 0 0;padding:0 4mm;'
    + `color:${muted};text-decoration:none;`;
  const numStyle = 'font-family:"EB Garamond",Georgia,serif;font-size:9pt;'
    + 'font-variant-numeric:oldstyle-nums;margin:-2mm 0 0;padding:0 4mm;'
    + `color:${muted};`;

  let css = '';
  for (const ch of chapters) {
    const n = ch.num;
    const chap = cssEsc(`Chapter ${roman(n)} · ${ch.label}`);
    // chN: chapter opener page — no running header, no page number.
    // chNb: chapter body pages — title on verso, chapter on recto, page number bottom outer.
    css += `
@page ch${n} { margin: 18mm 18mm 20mm 14mm; }
@page ch${n}:left { margin: 18mm 18mm 20mm 14mm; }
@page ch${n}:right { margin: 18mm 14mm 20mm 18mm; }
@page ch${n}b:left {
  margin: 18mm 18mm 20mm 14mm;
  @top-left { content: "${title}"; ${headStyle} }
  @bottom-left { content: counter(page); ${numStyle} }
}
@page ch${n}b:right {
  margin: 18mm 14mm 20mm 18mm;
  @top-right { content: "${chap}"; ${headStyle} }
  @bottom-right { content: counter(page); ${numStyle} }
}`;
  }
  style.textContent = css;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ fin */

function buildFin(record) {
  const sec = el('section', 'fin');
  sec.id = 'fin';
  sec.appendChild(el('p', 'fin-orn', '❦'));
  sec.appendChild(el('h2', 'fin-word', 'Fin'));
  const msgs = record.messages;
  if (msgs.length) {
    sec.appendChild(el('p', 'fin-date', `Last message · ${longDate(msgs[msgs.length - 1].ts)}`));
  }
  return sec;
}

/* ----------------------------------------------------------------- main */

export async function renderBook(record, root, { includeImages = true, theme = 'classic' } = {}) {
  if (!record || !Array.isArray(record.messages)) throw new TypeError('renderBook: record with messages[] required');
  if (!(root instanceof HTMLElement)) throw new TypeError('renderBook: root element required');

  watchedImages.clear();
  document.documentElement.lang = 'en';
  document.documentElement.classList.toggle('theme-midnight', theme === 'midnight');
  document.body.classList.toggle('theme-midnight', theme === 'midnight');
  root.className = theme === 'midnight' ? 'theme-midnight' : 'theme-classic';

  const meta = deriveMeta(record);
  document.title = meta.title;

  root.replaceChildren();
  root.appendChild(buildCover(record, meta, root));
  root.appendChild(buildColophon(record, meta));

  const chapters = chapterize(record);
  root.appendChild(buildToc(chapters));
  for (const ch of chapters) {
    const open = buildChapterOpen(ch);
    open.style.page = `ch${ch.num}`;
    root.appendChild(open);
    const body = buildChapterBody(record, ch, { includeImages });
    body.style.page = `ch${ch.num}b`;
    root.appendChild(body);
  }
  root.appendChild(buildFin(record));

  injectPageRules(record, meta, chapters);

  await finishImages(20000);
}
