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
        .card { position: fixed; right: 20px; bottom: 84px; z-index: 2147483647; width: 300px; box-sizing: border-box;
          font: 13px/1.45 "gg sans", "Segoe UI", system-ui, sans-serif; color: #f2f3f5; background: #1e1f22;
          border: 1px solid #3f4147; border-radius: 12px; padding: 14px 16px; box-shadow: 0 12px 32px rgba(0,0,0,.45); }
        .head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
        .head svg { flex: none; }
        .status { margin: 8px 0 10px; color: #dbdee1; white-space: pre-line; }
        .bar { height: 4px; border-radius: 2px; background: #313338; overflow: hidden; }
        .bar i { display: block; height: 100%; width: 30%; background: #c9a227; border-radius: 2px; animation: slide 1.2s ease-in-out infinite; }
        .done .bar i { animation: none; width: 100%; }
        .error .bar i { animation: none; width: 100%; background: #f23f43; }
        @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(340%); } }
        .row { display: flex; justify-content: flex-end; margin-top: 12px; gap: 8px; }
        button { font: inherit; font-weight: 600; color: #f2f3f5; background: #4e5058; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
        button:hover { background: #6d6f78; }
        .hint { color: #949ba4; font-size: 12px; margin-top: 8px; }
      </style>
      <div class="card">
        <div class="head"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c9a227" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>Discord Book</div>
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

  async function run(options) {
    const scraper = window.DiscordBookScraper;
    const chat = scraper.getChatInfo();
    if (!chat) throw new Error('Open a DM or channel first.');
    let pair = options.mode === 'pair' ? options.pair.map((s) => s.trim()).filter(Boolean) : null;
    if (pair && pair.length !== 2) throw new Error('Enter two names for the two-person mode.');

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
      messages = messages.filter((m) => !m.system && pair.some((name) => matchesPerson(m.author, name)));
      pair = pair.map((name) => messages.find((m) => matchesPerson(m.author, name)).author.name);
    }
    if (!messages.length) throw new Error('No messages found in this chat.');

    show(`Saving ${messages.length.toLocaleString()} messages and opening your book…`);
    const data = {
      chat,
      mode: pair ? 'pair' : 'full',
      pair,
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
