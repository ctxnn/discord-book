(() => {
  if (window.__discordBookContent) return;
  window.__discordBookContent = true;

  let job = null;
  let panel = null;

  const normalize = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

  function ui() {
    if (panel) return panel;
    const host = document.createElement('div');
    host.id = 'discord-book-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card { position: fixed; right: 20px; bottom: 84px; z-index: 2147483647; width: 312px; box-sizing: border-box;
          font: 13px/1.45 "gg sans", "Segoe UI", system-ui, sans-serif; color: #f1ebdd;
          background: radial-gradient(120% 70% at 0% 0%, rgba(214,180,108,.10), transparent 60%), #16130f;
          border: 1px solid #3a3329; border-radius: 14px; padding: 14px 16px 13px;
          box-shadow: 0 18px 44px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04); }
        .head { display: flex; align-items: center; gap: 10px; }
        .mark { position: relative; flex: none; width: 20px; height: 26px; border-radius: 2px 3px 3px 2px;
          background: linear-gradient(90deg, rgba(0,0,0,.35) 0 2px, transparent 2px), #6b2328;
          box-shadow: inset 0 0 0 1px rgba(214,180,108,.4), 0 3px 8px rgba(0,0,0,.45); }
        .mark::before { content: ""; position: absolute; left: 6px; right: 4px; top: 6px; height: 6px;
          border-top: 1px solid #d6b46c; border-bottom: 1px solid #d6b46c; }
        .title { font: italic 600 17px/1 Georgia, "Times New Roman", serif; letter-spacing: .01em; }
        .kicker { display: block; font-size: 9.5px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #d6b46c; margin-bottom: 3px; }
        .status { margin: 11px 0 10px; color: #d8cfbd; white-space: pre-line; font-variant-numeric: tabular-nums; }
        .status::first-line { color: #f1ebdd; font-weight: 600; }
        .bar { position: relative; height: 3px; border-radius: 3px; background: #2a251e; overflow: hidden; }
        .bar i { position: absolute; top: 0; bottom: 0; left: 0; width: 34%; border-radius: 3px;
          background: linear-gradient(90deg, transparent, #d6b46c 40%, #f0d9a2 60%, transparent);
          animation: slide 1.4s ease-in-out infinite; }
        .done .bar i { animation: none; width: 100%; background: linear-gradient(90deg, #b8914a, #d6b46c); }
        .error .bar i { animation: none; width: 100%; background: #e0645f; }
        .error .kicker { color: #e0645f; }
        @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
        .hint { color: #9a907e; font-size: 11.5px; margin-top: 9px; }
        .row { display: flex; justify-content: flex-end; margin-top: 12px; gap: 8px; }
        button { font: inherit; font-weight: 600; font-size: 12px; color: #f1ebdd; background: #28231c; border: 0; border-radius: 8px;
          padding: 6px 13px; cursor: pointer; box-shadow: inset 0 0 0 1px #3a3329; }
        button:hover { background: #352e25; }
      </style>
      <div class="card">
        <div class="head"><span class="mark"></span><div><span class="kicker">Making your book</span><span class="title">Discord Book</span></div></div>
        <div class="status"></div>
        <div class="bar"><i></i></div>
        <div class="hint">Keep this tab open and in front until reading finishes.</div>
        <div class="row"><button class="cancel">Cancel</button></div>
      </div>`;
    shadow.querySelector('.cancel').addEventListener('click', () => {
      if (job) job.controller.abort();
      else hide();
    });
    document.documentElement.appendChild(host);
    panel = { host, card: shadow.querySelector('.card'), status: shadow.querySelector('.status'), button: shadow.querySelector('.cancel'), hint: shadow.querySelector('.hint') };
    return panel;
  }

  function show(text, state = 'working') {
    const p = ui();
    p.status.textContent = text;
    p.card.className = `card ${state === 'working' ? '' : state}`;
    p.button.textContent = state === 'working' ? 'Cancel' : 'Close';
    p.hint.hidden = state !== 'working';
  }

  function hide() {
    panel?.host.remove();
    panel = null;
  }

  const monthYear = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

  function participantsOf(messages) {
    const byName = new Map();
    for (const m of messages) {
      if (!m.author?.name) continue;
      const k = m.author.id || normalize(m.author.name);
      const p = byName.get(k) || { name: m.author.name, id: m.author.id || null, avatar: m.author.avatar || null, count: 0 };
      p.count += 1;
      p.avatar = p.avatar || m.author.avatar || null;
      byName.set(k, p);
    }
    return [...byName.values()].sort((a, b) => b.count - a.count);
  }

  function matchesPerson(author, wanted) {
    if (!author) return false;
    const w = normalize(wanted);
    return normalize(author.name) === w || (author.id && author.id === w);
  }

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function phraseMatcher(phrases) {
    if (!phrases.length) return () => false;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${phrases.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
    return (m) => pattern.test(m.text || '');
  }

  function mentionedNames(m) {
    if (!m.html || !m.html.includes('mention')) return [];
    const doc = new DOMParser().parseFromString(m.html, 'text/html');
    return [...doc.querySelectorAll('span.mention')].map((s) => s.textContent.replace(/^@/, ''));
  }

  function conversationBetween(messages, pair, filter) {
    const says = phraseMatcher(filter.phrases);
    const whoOf = (m) => (m.system ? -1 : pair.findIndex((name) => matchesPerson(m.author, name)));
    const keep = new Set();
    let last = null;
    let othersSince = 0;
    for (const m of messages) {
      const who = whoOf(m);
      if (who < 0) {
        othersSince += 1;
        continue;
      }
      const other = pair[1 - who];
      const addressesOther = filter.replies && (
        (m.reply && matchesPerson({ name: m.reply.author }, other)) ||
        mentionedNames(m).some((n) => normalize(n) === normalize(other))
      );
      const quickAnswer = filter.backAndForth && last && last.who !== who &&
        Date.parse(m.ts) - Date.parse(last.m.ts) <= 3 * 60 * 1000 && othersSince < 5;
      if (addressesOther || says(m)) keep.add(m);
      if (quickAnswer) {
        keep.add(m);
        keep.add(last.m);
      }
      last = { m, who };
      othersSince = 0;
    }
    return messages.filter((m) => keep.has(m));
  }

  async function run(options) {
    const scraper = window.DiscordBookScraper;
    const chat = scraper.getChatInfo();
    if (!chat) throw new Error('Open a DM or channel first.');
    let pair = options.mode === 'pair' ? options.pair.map((s) => s.trim()).filter(Boolean) : null;
    if (pair && pair.length !== 2) throw new Error('Enter two names for the two-person mode.');
    const filter = pair ? {
      scope: options.filter?.scope === 'conversation' ? 'conversation' : 'all',
      replies: options.filter?.replies !== false,
      backAndForth: options.filter?.backAndForth !== false,
      phrases: (options.filter?.phrases || []).map((p) => p.trim()).filter(Boolean)
    } : null;
    if (filter?.scope === 'conversation' && !filter.replies && !filter.backAndForth && !filter.phrases.length) {
      throw new Error('Pick at least one thing to keep, or type words to look for.');
    }

    const controller = new AbortController();
    job = { controller, chat };
    show(`Reading ${chat.title}…`);
    const result = await scraper.scrape({
      fromDate: options.fromDate ? new Date(options.fromDate) : null,
      maxMessages: options.maxMessages || Infinity,
      signal: controller.signal,
      onProgress: (p) => show(`Reading ${chat.title}…\n${p.collected.toLocaleString()} messages${p.oldestTs ? ` · back to ${monthYear(p.oldestTs)}` : ''}`)
    });

    let messages = result.messages;
    if (pair) {
      const missing = pair.filter((name) => !messages.some((m) => matchesPerson(m.author, name)));
      if (missing.length) {
        const seen = participantsOf(messages).slice(0, 12).map((p) => p.name).join(', ');
        throw new Error(`No messages from ${missing.join(' and ')} here. Names found: ${seen || 'none'}.`);
      }
      pair = pair.map((name) => messages.find((m) => matchesPerson(m.author, name)).author.name);
      messages = filter.scope === 'conversation'
        ? conversationBetween(messages, pair, filter)
        : messages.filter((m) => !m.system && pair.some((name) => matchesPerson(m.author, name)));
      if (!messages.length) throw new Error(`Nothing matched: ${pair.join(' and ')} never reply to, mention, or quickly answer each other here${filter.phrases.length ? ', or say ' + filter.phrases.map((p) => `"${p}"`).join(', ') : ''}.`);
    }
    if (!messages.length) throw new Error('No messages found in this chat.');

    show(`Saving ${messages.length.toLocaleString()} messages and opening your book…`);
    const data = {
      chat,
      mode: pair ? 'pair' : 'full',
      pair,
      filter,
      complete: result.complete && !options.fromDate,
      participants: participantsOf(messages),
      messages
    };
    const reply = await chrome.runtime.sendMessage({ type: 'export:save', data, options: { includeImages: options.includeImages !== false, theme: options.theme } });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not save the export.');
    return { count: messages.length, version: reply.version, complete: data.complete };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const scraper = window.DiscordBookScraper;
    if (message.type === 'ping') {
      sendResponse({ ok: true });
    } else if (message.type === 'info') {
      sendResponse({ ok: true, chat: scraper.getChatInfo(), authors: scraper.listVisibleAuthors(), busy: !!job });
    } else if (message.type === 'start') {
      if (job) {
        sendResponse({ ok: false, error: 'An export is already running in this tab.' });
        return;
      }
      sendResponse({ ok: true });
      run(message.options).then(
        (r) => {
          show(`Done: ${r.count.toLocaleString()} messages, edition ${r.version}.${r.complete ? '' : '\nThe book starts partway through the chat.'}\nYour PDF is being made in the new tab.`, 'done');
          setTimeout(hide, 8000);
        },
        (e) => show(e?.name === 'AbortError' ? 'Cancelled.' : String(e?.message || e), e?.name === 'AbortError' ? 'done' : 'error')
      ).finally(() => { job = null; });
    }
  });
})();
