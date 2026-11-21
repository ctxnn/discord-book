/**
 * Discord DOM mock — simulates Discord's web chat UI with virtualized scrolling.
 * Exposes window.__mockTruth = array of all generated messages.
 */

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // Config from query string
  // -----------------------------------------------------------------------
  var params = new URLSearchParams(window.location.search);
  var MOCK_KIND = params.get('kind') || 'dm'; // 'dm' or 'channel'
  var MOCK_FAST = params.has('fast'); // fast mode for tests: minimal delays

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  var DISCORD_EPOCH = 1420070400000;
  var CHANNEL_ID = '123456789012345678';
  var GUILD_ID = MOCK_KIND === 'channel' ? '987654321098765432' : '@me';

  var PAGE_SIZE = 50;
  var MAX_DOM_ITEMS = 150;
  var LOAD_DELAY_MIN = MOCK_FAST ? 50 : 300;
  var LOAD_DELAY_MAX = MOCK_FAST ? 150 : 1200;

  // Authors
  var AUTHORS = [
    { name: 'Alice', id: '111111111111111111', avatar: 'https://cdn.discordapp.com/avatars/111111111111111111/a_alice.webp?size=80' },
    { name: 'Bob', id: '222222222222222222', avatar: 'https://cdn.discordapp.com/avatars/222222222222222222/b_bob.webp?size=80' },
    { name: 'Charlie', id: '333333333333333333', avatar: 'https://cdn.discordapp.com/avatars/333333333333333333/c_charlie.webp?size=80' }
  ];

  // -----------------------------------------------------------------------
  // Snowflake helpers
  // -----------------------------------------------------------------------
  function msToSnowflake(ms) {
    // Simulate Discord snowflake: (ms - epoch) << 22 | random lower bits
    var timestamp = BigInt(ms) - BigInt(DISCORD_EPOCH);
    var worker = BigInt(Math.floor(Math.random() * 31));
    var process = BigInt(Math.floor(Math.random() * 31));
    var increment = BigInt(Math.floor(Math.random() * 4095));
    return String((timestamp << 22n) | (worker << 17n) | (process << 12n) | increment);
  }

  function snowflakeToMs(id) {
    return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  }

  // -----------------------------------------------------------------------
  // Message generation
  // -----------------------------------------------------------------------

  // We'll generate ~700 messages over ~14 months, clustered around
  // conversation bursts.
  function generateMessages() {
    var messages = [];
    var now = Date.now();
    var start = now - (14 * 30 * 24 * 60 * 60 * 1000); // ~14 months ago

    // Helper: add a burst of messages
    var nextTime = start;
    function addBurst(authorIdx, count, timeSpanMs, templates, extra) {
      for (var i = 0; i < count; i++) {
        var t = nextTime + Math.floor((i / count) * timeSpanMs);
        var msg = makeMessage(t, authorIdx, templates, extra, messages);
        messages.push(msg);
      }
      nextTime += timeSpanMs + Math.floor(Math.random() * 6 * 60 * 60 * 1000); // gap after burst
    }

    // Template pools
    var casualTemplates = [
      'Hey, how are you?',
      'I\'m doing great, thanks!',
      'What are you up to today?',
      'Not much, just working on some stuff.',
      'That sounds fun!',
      'Yeah, it\'s been pretty productive.',
      'Did you see the new update?',
      'No, what update?',
      'The one that came out yesterday.',
      'Oh right, I haven\'t checked yet.',
      'It\'s pretty cool actually.',
      'Nice, I\'ll check it out.',
      'How\'s the weather over there?',
      'Pretty good, sunny and warm.',
      'Same here!',
      'We should catch up sometime.',
      'Definitely!',
      'How\'s the project going?',
      'Going well, almost done with the first phase.',
      'Awesome, can\'t wait to see it!',
      'Me too, it\'s been a lot of work.',
      'I bet, but it\'ll be worth it.',
      'For sure!',
      'What time is the meeting tomorrow?',
      'I think it\'s at 3pm.',
      'Got it, thanks!',
      'No problem!',
      'Hey, can you send me that file?',
      'Sure, one sec.',
      'Here you go!',
      'Thanks!',
      'You\'re welcome!',
      'Anyone up for a game tonight?',
      'I\'m in!',
      'Me too!',
      'What time?',
      'How about 8pm?',
      'Works for me!',
      'Same here.',
      'Great, see you then!',
      'Did you finish the book I recommended?',
      'Almost! I have about 50 pages left.',
      'What do you think so far?',
      'It\'s really good, thanks for the recommendation!',
      'Glad you like it!',
      'The plot twist in chapter 12 was insane.',
      'I know right?!',
      'Didn\'t see that coming at all.',
      'Neither did I haha',
      'What are you reading next?',
      'Not sure yet, any suggestions?',
      'I have a few ideas, let me think.',
      'Cool, let me know!',
      'Will do!',
      'Random question: tacos or burritos?',
      'Tacos, definitely.',
      'Burritos for me.',
      'Both are great tbh.',
      'Fair enough!',
      'lol',
      'haha',
      '😂',
      '👍',
      '💯',
      '🔥',
      'Good morning!',
      'Morning!',
      'Good night!',
      'Night, talk tomorrow!',
      'gn!',
      'How was your weekend?',
      'It was great! Went hiking.',
      'Oh nice, where?',
      'Up at the state park.',
      'Beautiful trails there.',
      'Yeah, the views were amazing.',
      'We should go together sometime.',
      'That would be fun!',
      'Let\'s plan it.',
      'Sounds good!',
      'What\'s for lunch?',
      'I had a sandwich.',
      'Nice, I\'m thinking pizza.',
      'Pizza sounds amazing.',
      'Do it!',
      'Maybe I will haha',
      'Any plans for the holidays?',
      'Visiting family probably.',
      'Same here.',
      'Should be nice!',
      'Yeah, looking forward to it.',
      'Movie recommendation: did you see Dune Part Two?',
      'Yes! It was incredible.',
      'The visuals were stunning.',
      'And the soundtrack!',
      'Hans Zimmer killed it.',
      'Absolutely.',
      'One of the best sci-fi movies in years.',
      'Agreed 100%.'
    ];

    var techTemplates = [
      'Has anyone tried the new TypeScript 5.5?',
      'Yeah, the inferred type predicates are nice.',
      'The speed improvements are noticeable too.',
      'I\'ve been playing with Rust lately.',
      'How are you finding it?',
      'The borrow checker is frustrating but the language is great.',
      'It gets easier after a while.',
      'That\'s what everyone says haha',
      'Check out this code:',
      'I found a bug in the auth middleware.',
      'What was the issue?',
      'The token validation was skipping the expiry check.',
      'Oof, that\'s a big one.',
      'Yeah, already pushed a fix.',
      'Nice catch!',
      'Anyone know a good library for PDF generation?',
      'I\'ve used pdf-lib, it works well.',
      'Puppeteer is also an option if you need HTML to PDF.',
      'True, but it\'s heavy.',
      'Fair point.',
      'What\'s your tech stack these days?',
      'Next.js with TypeScript, Prisma, and PostgreSQL.',
      'Solid choice.',
      'I\'ve been using Bun instead of Node.',
      'How is it?',
      'Really fast, and the DX is great.',
      'I need to try it.',
      'The monorepo setup is a bit complex.',
      'Tell me about it...',
      'We use Turborepo and it helps a lot.',
      'pnpm workspaces are decent too.',
      'I prefer Nx for larger projects.',
      'Interesting, I haven\'t tried Nx.',
      'It has a learning curve but it\'s powerful.',
      'CI/CD pipeline is finally green!',
      'Congrats! That took a while.',
      'Yeah, three weeks of debugging flaky tests.',
      'Flaky tests are the worst.',
      'Preach.',
      'What editor are you using?',
      'VS Code with the Vim extension.',
      'Neovim btw.',
      'Classic.'
    ];

    var funTemplates = [
      'Look at this meme 😂',
      'That\'s hilarious',
      'I\'m dead 💀',
      'Sending this to everyone',
      'Where do you find these?',
      'Reddit mostly',
      'Ah, makes sense',
      'Check out this song: https://open.spotify.com/track/example',
      'Added to my playlist!',
      'The new album is fire',
      'I\'ve had it on repeat all week',
      'Same, every track is good.',
      'Except track 7 maybe',
      'No way, track 7 is the best one!',
      'Hot take 🔥',
      'Agree to disagree haha',
      'Anyone watching the game tonight?',
      'Who\'s playing?',
      'Lakers vs Celtics',
      'Oh that\'s gonna be good',
      'Rooting for the Celtics',
      'Lakers all the way!',
      'It\'s gonna be a close one.',
      'What a game!',
      'That last quarter was intense.',
      'Best game I\'ve seen all season.',
      'For real.',
      'Did you see that dunk?!',
      'Insane athleticism.',
      'Highlight reel material for sure.'
    ];

    var allTemplates = casualTemplates.concat(techTemplates).concat(funTemplates);

    // Generate messages across the time range
    var authorIdx = 0;
    var burstCount = 0;

    while (nextTime < now && messages.length < 700) {
      var burstSize = 2 + Math.floor(Math.random() * 8);
      var burstSpan = burstSize * (30 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000));
      var templateSet = allTemplates;
      var extra = null;

      // Every ~15 bursts, insert something special
      if (burstCount % 15 === 0 && burstCount > 0) {
        var specialType = burstCount % 60;
        if (specialType < 15) {
          extra = { type: 'image' };
        } else if (specialType < 30) {
          extra = { type: 'file' };
        } else if (specialType < 40) {
          extra = { type: 'embed' };
        } else if (specialType < 50) {
          extra = { type: 'reply' };
        } else {
          extra = { type: 'sticker' };
        }
      }

      addBurst(authorIdx % 3, burstSize, burstSpan, templateSet, extra);
      authorIdx++;
      burstCount++;
    }

    // Trim to ~700
    if (messages.length > 700) {
      messages = messages.slice(0, 700);
    }

    // Add a system message near the beginning
    var sysMsgTime = snowflakeToMs(messages[3].id) + 1000;
    var sysMsg = {
      id: msToSnowflake(sysMsgTime),
      author: null,
      authorName: null,
      authorId: null,
      authorAvatar: null,
      text: 'Alice started a call that lasted 2 hours.',
      html: 'Alice started a call that lasted 2 hours.',
      system: true,
      edited: false,
      reply: null,
      attachments: [],
      embeds: [],
      stickers: [],
      reactions: []
    };
    messages.splice(4, 0, sysMsg);

    // Another system message in the middle
    var midIdx = Math.floor(messages.length / 2);
    var midMsgTime = snowflakeToMs(messages[midIdx].id) + 1000;
    var midSysMsg = {
      id: msToSnowflake(midMsgTime),
      author: null,
      authorName: null,
      authorId: null,
      authorAvatar: null,
      text: 'Bob pinned a message to this channel.',
      html: 'Bob pinned a message to this channel.',
      system: true,
      edited: false,
      reply: null,
      attachments: [],
      embeds: [],
      stickers: [],
      reactions: []
    };
    messages.splice(midIdx, 0, midSysMsg);

    // Mark every ~20th message as edited
    for (var ei = 0; ei < messages.length; ei++) {
      if (ei % 20 === 0 && !messages[ei].system) {
        messages[ei].edited = true;
      }
    }

    // Add reactions to some messages
    for (var ri = 0; ri < messages.length; ri++) {
      if (ri % 7 === 0 && !messages[ri].system) {
        messages[ri].reactions = [
          { emoji: '👍', emojiUrl: null, count: Math.floor(Math.random() * 5) + 1 },
          { emoji: '❤️', emojiUrl: null, count: Math.floor(Math.random() * 3) + 1 }
        ];
      }
      if (ri % 13 === 0 && !messages[ri].system) {
        if (!messages[ri].reactions) messages[ri].reactions = [];
        messages[ri].reactions.push({
          emoji: null,
          emojiUrl: 'https://cdn.discordapp.com/emojis/987654321098765432.webp',
          count: Math.floor(Math.random() * 3) + 1
        });
      }
    }

    // Ensure we have at least one of each special type in the last 100 messages
    // (so they're visible in the initial render)
    ensureSpecialTypes(messages);

    return messages;
  }

  function ensureSpecialTypes(messages) {
    var last100 = messages.slice(-100);
    var hasReply = false, hasImage = false, hasFile = false, hasEmbed = false, hasSticker = false, hasCode = false;
    for (var i = 0; i < last100.length; i++) {
      if (last100[i].reply) hasReply = true;
      if (last100[i].attachments && last100[i].attachments.some(function (a) { return a.type === 'image'; })) hasImage = true;
      if (last100[i].attachments && last100[i].attachments.some(function (a) { return a.type === 'file'; })) hasFile = true;
      if (last100[i].embeds && last100[i].embeds.length > 0) hasEmbed = true;
      if (last100[i].stickers && last100[i].stickers.length > 0) hasSticker = true;
      if (last100[i].text && last100[i].text.indexOf('```') !== -1) hasCode = true;
    }

    // Patch some recent messages to include missing types
    var patchIdx = messages.length - 50;
    if (!hasReply && patchIdx > 0) {
      messages[patchIdx].reply = { author: AUTHORS[(Math.floor(Math.random() * 3))].name, text: 'This is a replied-to message snippet' };
      patchIdx += 3;
    }
    if (!hasImage && patchIdx > 0) {
      messages[patchIdx].attachments = [
        { type: 'image', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect fill="#5865f2" width="400" height="300"/><text fill="white" font-size="24" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">Mock Image</text></svg>'), name: 'screenshot.png', width: 400, height: 300 }
      ];
      patchIdx += 3;
    }
    if (!hasFile && patchIdx > 0) {
      messages[patchIdx].attachments = [
        { type: 'file', url: 'https://cdn.discordapp.com/attachments/123456789012345678/999999999999999999/document.pdf', name: 'report.pdf', size: '2.4 MB' }
      ];
      patchIdx += 3;
    }
    if (!hasEmbed && patchIdx > 0) {
      messages[patchIdx].embeds = [
        {
          provider: 'GitHub',
          author: 'ctxnn',
          title: 'Fix: resolve race condition in message processor',
          description: 'The message processor was accessing shared state without proper synchronization. This PR adds a mutex around the critical section.',
          url: 'https://github.com/ctxnn/discord-book/pull/42',
          image: null,
          color: '#5865f2'
        }
      ];
      patchIdx += 3;
    }
    if (!hasSticker && patchIdx > 0) {
      messages[patchIdx].stickers = [
        { name: 'penguin_dance', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><circle fill="#ffcc00" cx="80" cy="80" r="60"/><text font-size="48" x="50%" y="55%" text-anchor="middle" dominant-baseline="middle">🐧</text></svg>') }
      ];
      patchIdx += 3;
    }
    if (!hasCode && patchIdx > 0) {
      messages[patchIdx].text = 'Here is the fix:\n```js\nfunction fixBug() {\n  if (token.expiry < Date.now()) {\n    throw new Error("Token expired");\n  }\n  return processToken(token);\n}\n```';
      messages[patchIdx].html = 'Here is the fix:<pre><code>function fixBug() {\n  if (token.expiry &lt; Date.now()) {\n    throw new Error("Token expired");\n  }\n  return processToken(token);\n}</code></pre>';
    }
  }

  function makeMessage(time, authorIdx, templates, extra, existingMessages) {
    var author = AUTHORS[authorIdx];
    var id = msToSnowflake(time);

    // Pick a template
    var templateIdx = Math.floor(Math.random() * templates.length);
    var text = templates[templateIdx];

    // Determine if this should be a grouped follow-up (same author as previous, within 5 min)
    var isGrouped = false;
    if (existingMessages.length > 0) {
      var prev = existingMessages[existingMessages.length - 1];
      if (prev.authorName === author.name && (time - snowflakeToMs(prev.id)) < 5 * 60 * 1000) {
        isGrouped = true;
      }
    }

    // Build HTML from text
    var html = textToHtml(text);

    // Handle extra types
    var reply = null;
    var attachments = [];
    var embeds = [];
    var stickers = [];

    if (extra) {
      if (extra.type === 'reply') {
        var replyAuthor = AUTHORS[(authorIdx + 1) % 3];
        reply = { author: replyAuthor.name, text: 'Some earlier message that was replied to' };
      } else if (extra.type === 'image') {
        attachments = [
          { type: 'image', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect fill="#57f287" width="600" height="400"/><text fill="white" font-size="32" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">Photo</text></svg>'), name: 'photo.png', width: 600, height: 400 }
        ];
      } else if (extra.type === 'file') {
        attachments = [
          { type: 'file', url: 'https://cdn.discordapp.com/attachments/123456789012345678/888888888888888888/notes.txt', name: 'notes.txt', size: '12 KB' }
        ];
      } else if (extra.type === 'embed') {
        embeds = [
          {
            provider: 'YouTube',
            author: 'Channel Name',
            title: 'How to Build a Discord Bot',
            description: 'A comprehensive tutorial on building Discord bots with Node.js',
            url: 'https://www.youtube.com/watch?v=example',
            image: null,
            color: '#ff0000'
          }
        ];
      } else if (extra.type === 'sticker') {
        stickers = [
          { name: 'cat_wave', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><circle fill="#ff9999" cx="80" cy="80" r="60"/><text font-size="48" x="50%" y="55%" text-anchor="middle" dominant-baseline="middle">🐱</text></svg>') }
        ];
      }
    }

    // Add @mentions randomly
    if (Math.random() < 0.15) {
      var mentionAuthor = AUTHORS[(authorIdx + 1 + Math.floor(Math.random() * 2)) % 3];
      text = '@' + mentionAuthor.name + ' ' + text;
      html = '<span class="mention_d5deea">@' + mentionAuthor.name + '</span> ' + html;
    }

    // Add a spoiler sometimes
    if (Math.random() < 0.08) {
      text += ' ||spoiler content here||';
      html += ' <span class="spoilerContent_d5deea">spoiler content here</span>';
    }

    // Add a custom emoji sometimes
    if (Math.random() < 0.1) {
      text += ' :pogchamp:';
      html += ' <img class="emoji" src="https://cdn.discordapp.com/emojis/777777777777777777.webp" alt=":pogchamp:" data-type="emoji">';
    }

    // Add unicode emoji sometimes (as text, not img — Discord renders unicode emoji as img tags though)
    if (Math.random() < 0.2) {
      var unicodeEmojis = ['👍', '❤️', '😂', '🔥', '🎉', '😊', '💀', '👀', '✨', '🙏'];
      var ue = unicodeEmojis[Math.floor(Math.random() * unicodeEmojis.length)];
      text += ' ' + ue;
      // Render as img like Discord does for unicode emoji
      html += ' <img class="emoji" src="data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><text font-size="18" x="50%" y="70%" text-anchor="middle">' + ue + '</text></svg>') + '" alt="' + ue + '" data-type="emoji">';
    }

    return {
      id: id,
      author: null, // resolved later by renderer
      authorName: author.name,
      authorId: author.id,
      authorAvatar: author.avatar,
      text: text,
      html: html,
      edited: false,
      system: false,
      reply: reply,
      attachments: attachments,
      embeds: embeds,
      stickers: stickers,
      reactions: [],
      isGrouped: isGrouped
    };
  }

  function textToHtml(text) {
    // Basic markdown-like conversion
    var html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    // Handle code blocks (pre-formatted)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      return '<pre><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });

    // Handle blockquotes
    html = html.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

    return html;
  }

  // -----------------------------------------------------------------------
  // Generate truth data
  // -----------------------------------------------------------------------
  var ALL_MESSAGES = generateMessages();

  // Sort by id — system messages were inserted at specific positions and
  // may have ids that break chronological order.
  ALL_MESSAGES.sort(function (a, b) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // Resolve authors for grouped messages, and fix isGrouped for messages
  // that now follow system messages (system messages break visual grouping).
  for (var i = 0; i < ALL_MESSAGES.length; i++) {
    if (ALL_MESSAGES[i].system) {
      ALL_MESSAGES[i].isGrouped = false;
      continue;
    }
    if (i === 0) {
      ALL_MESSAGES[i].isGrouped = false;
      continue;
    }
    var prev = ALL_MESSAGES[i - 1];
    // A message is only grouped if the previous message is from the same
    // author and is itself a regular (non-system) message.
    if (!prev.system && prev.authorName === ALL_MESSAGES[i].authorName) {
      ALL_MESSAGES[i].isGrouped = true;
      ALL_MESSAGES[i].authorName = prev.authorName;
      ALL_MESSAGES[i].authorId = prev.authorId;
      ALL_MESSAGES[i].authorAvatar = prev.authorAvatar;
    } else {
      ALL_MESSAGES[i].isGrouped = false;
    }
  }

  // Expose truth for tests
  window.__mockTruth = ALL_MESSAGES.map(function (m) {
    return {
      id: m.id,
      authorName: m.authorName,
      authorId: m.authorId,
      text: m.text,
      system: m.system || false,
      edited: m.edited || false,
      reply: m.reply,
      attachments: m.attachments,
      embeds: m.embeds,
      stickers: m.stickers,
      reactions: m.reactions,
      isGrouped: m.isGrouped
    };
  });

  // -----------------------------------------------------------------------
  // DOM rendering
  // -----------------------------------------------------------------------
  var ol = document.getElementById('messageList');
  var scroller = document.getElementById('scroller');
  var channelTitle = document.getElementById('channelTitle');
  var sectionHeader = document.querySelector('section[aria-label="Channel header"]');

  // Set up title based on kind
  if (MOCK_KIND === 'channel') {
    channelTitle.textContent = '#general';
    document.title = 'Discord | #general | Test Server';
    // Add server name in header if not present
    var h1 = sectionHeader.querySelector('h1');
    if (h1) h1.textContent = '#general';
  } else {
    channelTitle.textContent = '@alice';
    document.title = 'Discord | @alice';
  }

  var isLoading = false;

  function makeMessageDOM(msg, isGrouped) {
    var li = document.createElement('li');
    li.id = 'chat-messages-' + CHANNEL_ID + '-' + msg.id;
    li.className = 'message_d5deea' + (isGrouped ? ' grouped_f3e4a2' : '');

    // System message
    if (msg.system) {
      li.className = 'message_d5deea';
      var sysDiv = document.createElement('div');
      sysDiv.className = 'systemMessage_d5deea';
      var sysContent = document.createElement('div');
      sysContent.className = 'content_ba5f50';
      sysContent.textContent = msg.text;
      sysDiv.appendChild(sysContent);
      li.appendChild(sysDiv);
      return li;
    }

    // Reply context
    if (msg.reply) {
      var replyDiv = document.createElement('div');
      replyDiv.id = 'message-reply-context-' + msg.id;
      replyDiv.className = 'replyContainer_f07d62';
      var replyAuthorSpan = document.createElement('span');
      replyAuthorSpan.className = 'username_c19a55';
      replyAuthorSpan.textContent = msg.reply.author;
      var replyTextSpan = document.createElement('span');
      replyTextSpan.className = 'repliedTextContent_c19a55';
      replyTextSpan.textContent = msg.reply.text;
      replyDiv.appendChild(replyAuthorSpan);
      replyDiv.appendChild(document.createTextNode(' '));
      replyDiv.appendChild(replyTextSpan);
      li.appendChild(replyDiv);
    }

    // Avatar and header (only for non-grouped)
    if (!isGrouped) {
      var avatarWrapper = document.createElement('div');
      avatarWrapper.className = 'avatarWrapper_b2c9e3';
      var avatarImg = document.createElement('img');
      avatarImg.className = 'avatar_b90a71';
      avatarImg.src = msg.authorAvatar;
      avatarImg.alt = msg.authorName;
      avatarWrapper.appendChild(avatarImg);
      li.appendChild(avatarWrapper);

      var header = document.createElement('h3');
      header.className = 'messageHeader_f07d62';
      var usernameSpanOuter = document.createElement('span');
      usernameSpanOuter.id = 'message-username-' + msg.id;
      var usernameSpan = document.createElement('span');
      usernameSpan.className = 'username_c19a55';
      usernameSpan.setAttribute('data-text', msg.authorName);
      usernameSpan.textContent = msg.authorName;
      usernameSpanOuter.appendChild(usernameSpan);

      var timeEl = document.createElement('time');
      timeEl.id = 'message-timestamp-' + msg.id;
      timeEl.className = 'timestamp_c19a55';
      var date = new Date(snowflakeToMs(msg.id));
      timeEl.setAttribute('datetime', date.toISOString());
      timeEl.textContent = formatTime(date);

      header.appendChild(usernameSpanOuter);
      header.appendChild(timeEl);
      li.appendChild(header);
    }

    // Content
    var contentDiv = document.createElement('div');
    contentDiv.id = 'message-content-' + msg.id;
    contentDiv.className = 'content_ba5f50';
    contentDiv.innerHTML = msg.html;

    if (msg.edited) {
      var editedSpan = document.createElement('span');
      editedSpan.className = 'edited_d5deea';
      editedSpan.textContent = '(edited)';
      contentDiv.appendChild(editedSpan);
    }

    li.appendChild(contentDiv);

    // Accessories
    var hasAccessories = (msg.attachments && msg.attachments.length > 0) ||
                         (msg.embeds && msg.embeds.length > 0) ||
                         (msg.stickers && msg.stickers.length > 0);

    if (hasAccessories) {
      var accessoriesDiv = document.createElement('div');
      accessoriesDiv.id = 'message-accessories-' + msg.id;
      accessoriesDiv.className = 'accessories_b9c3e4';

      // Attachments
      if (msg.attachments) {
        for (var ai = 0; ai < msg.attachments.length; ai++) {
          var att = msg.attachments[ai];
          if (att.type === 'image') {
            var wrapper = document.createElement('div');
            wrapper.className = 'imageWrapper_b2c9e3';
            var link = document.createElement('a');
            link.className = 'originalLink_f07d62';
            link.href = att.url;
            link.target = '_blank';
            var img = document.createElement('img');
            img.src = att.url;
            img.alt = att.name;
            if (att.width) img.setAttribute('width', att.width);
            if (att.height) img.setAttribute('height', att.height);
            link.appendChild(img);
            wrapper.appendChild(link);
            accessoriesDiv.appendChild(wrapper);
          } else if (att.type === 'file') {
            var fileDiv = document.createElement('div');
            fileDiv.className = 'attachment_d5deea';
            var fileLink = document.createElement('a');
            fileLink.className = 'fileNameLink_c19a55';
            fileLink.href = att.url;
            fileLink.textContent = att.name;
            var sizeSpan = document.createElement('span');
            sizeSpan.className = 'metadata_d5deea';
            sizeSpan.textContent = att.size || '';
            fileDiv.appendChild(fileLink);
            if (att.size) fileDiv.appendChild(sizeSpan);
            accessoriesDiv.appendChild(fileDiv);
          } else if (att.type === 'video') {
            var videoEl = document.createElement('video');
            videoEl.src = att.url;
            videoEl.setAttribute('poster', att.poster || '');
            videoEl.controls = true;
            videoEl.style.maxWidth = '400px';
            accessoriesDiv.appendChild(videoEl);
          }
        }
      }

      // Embeds
      if (msg.embeds) {
        for (var ei = 0; ei < msg.embeds.length; ei++) {
          var embed = msg.embeds[ei];
          var embedArticle = document.createElement('article');
          embedArticle.className = 'embedFull_b2c9e3';
          if (embed.color) {
            embedArticle.style.borderLeftColor = embed.color;
          }

          if (embed.provider) {
            var providerDiv = document.createElement('div');
            providerDiv.className = 'embedProvider_c19a55';
            providerDiv.textContent = embed.provider;
            embedArticle.appendChild(providerDiv);
          }
          if (embed.author) {
            var authorDiv = document.createElement('div');
            authorDiv.className = 'embedAuthor_c19a55';
            authorDiv.textContent = embed.author;
            embedArticle.appendChild(authorDiv);
          }
          if (embed.title) {
            var titleDiv = document.createElement('div');
            titleDiv.className = 'embedTitle_c19a55';
            var titleLink = document.createElement('a');
            titleLink.href = embed.url || '#';
            titleLink.textContent = embed.title;
            titleLink.target = '_blank';
            titleDiv.appendChild(titleLink);
            embedArticle.appendChild(titleDiv);
          }
          if (embed.description) {
            var descDiv = document.createElement('div');
            descDiv.className = 'embedDescription_c19a55';
            descDiv.textContent = embed.description;
            embedArticle.appendChild(descDiv);
          }
          if (embed.image) {
            var embedImgDiv = document.createElement('div');
            embedImgDiv.className = 'embedImage_c19a55';
            var embedImg = document.createElement('img');
            embedImg.src = embed.image;
            embedImgDiv.appendChild(embedImg);
            embedArticle.appendChild(embedImgDiv);
          }

          accessoriesDiv.appendChild(embedArticle);
        }
      }

      // Stickers
      if (msg.stickers) {
        for (var si = 0; si < msg.stickers.length; si++) {
          var sticker = msg.stickers[si];
          var stickerImg = document.createElement('img');
          stickerImg.className = 'sticker_d5deea';
          stickerImg.src = sticker.url;
          stickerImg.alt = sticker.name;
          stickerImg.setAttribute('aria-label', sticker.name);
          accessoriesDiv.appendChild(stickerImg);
        }
      }

      li.appendChild(accessoriesDiv);
    }

    // Reactions
    if (msg.reactions && msg.reactions.length > 0) {
      var reactionsDiv = document.createElement('div');
      reactionsDiv.id = 'message-reactions-' + msg.id;
      reactionsDiv.className = 'reactions_d5deea';

      for (var ri = 0; ri < msg.reactions.length; ri++) {
        var reaction = msg.reactions[ri];
        var reactionDiv = document.createElement('div');
        reactionDiv.className = 'reaction_d5deea';

        var reactionImg = document.createElement('img');
        if (reaction.emojiUrl) {
          reactionImg.src = reaction.emojiUrl;
          reactionImg.alt = ':custom_emoji:';
        } else {
          reactionImg.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text font-size="14" x="50%" y="70%" text-anchor="middle">' + (reaction.emoji || '') + '</text></svg>');
          reactionImg.alt = reaction.emoji || '';
        }

        var countSpan = document.createElement('span');
        countSpan.className = 'reactionCount_d5deea';
        countSpan.textContent = reaction.count;

        reactionDiv.appendChild(reactionImg);
        reactionDiv.appendChild(countSpan);
        reactionsDiv.appendChild(reactionDiv);
      }

      li.appendChild(reactionsDiv);
    }

    return li;
  }

  function formatTime(date) {
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    var today = new Date();
    var isToday = date.getDate() === today.getDate() &&
                  date.getMonth() === today.getMonth() &&
                  date.getFullYear() === today.getFullYear();
    if (isToday) {
      return 'Today at ' + date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    }
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    var isYesterday = date.getDate() === yesterday.getDate() &&
                      date.getMonth() === yesterday.getMonth() &&
                      date.getFullYear() === yesterday.getFullYear();
    if (isYesterday) {
      return 'Yesterday at ' + date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    }
    return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
  }

  // -----------------------------------------------------------------------
  // Virtualized scrolling
  // -----------------------------------------------------------------------
  function renderRange(startIdx, endIdx) {
    var fragment = document.createDocumentFragment();
    for (var i = startIdx; i <= endIdx && i < ALL_MESSAGES.length; i++) {
      var msg = ALL_MESSAGES[i];
      var isGrouped = msg.isGrouped;
      fragment.appendChild(makeMessageDOM(msg, isGrouped));
    }
    return fragment;
  }

  function clearList() {
    while (ol.firstChild) {
      ol.removeChild(ol.firstChild);
    }
  }

  var lo = 0;
  var hi = -1;
  var generation = 0;
  window.__mockLog = [];
  function logOp(op) { window.__mockLog.push({ t: Math.round(performance.now()), op: op, lo: lo, hi: hi, top: Math.round(scroller.scrollTop) }); }

  function randomDelay() {
    return LOAD_DELAY_MIN + Math.floor(Math.random() * (LOAD_DELAY_MAX - LOAD_DELAY_MIN));
  }

  function renderWindow(start, end) {
    clearList();
    lo = start;
    hi = end;
    ol.appendChild(renderRange(lo, hi));
    syncMarkers();
  }

  function renderInitial() {
    renderWindow(Math.max(0, ALL_MESSAGES.length - PAGE_SIZE), ALL_MESSAGES.length - 1);
    scroller.scrollTop = scroller.scrollHeight;
  }

  function removeFirst(n) {
    for (var i = 0; i < n; i++) {
      var li = ol.querySelector('li[id^="chat-messages-"]');
      if (li) li.parentNode.removeChild(li);
    }
  }

  function removeLast(n) {
    for (var i = 0; i < n; i++) {
      var lis = ol.querySelectorAll('li[id^="chat-messages-"]');
      if (lis.length) lis[lis.length - 1].parentNode.removeChild(lis[lis.length - 1]);
    }
  }

  function syncMarkers() {
    var marker = ol.querySelector('.emptyChannel_c19a55');
    if (lo === 0 && !marker) showBeginningMarker();
    if (lo > 0 && marker) marker.parentNode.parentNode.removeChild(marker.parentNode);
    if (hi < ALL_MESSAGES.length - 1) showJumpToPresentBar();
    else hideJumpToPresentBar();
  }

  function loadOlder() {
    if (isLoading || lo === 0) return;
    isLoading = true;
    var g = generation;
    setTimeout(function () {
      if (g !== generation) return;
      var start = Math.max(0, lo - PAGE_SIZE);
      var prevScrollHeight = scroller.scrollHeight;
      var prevScrollTop = scroller.scrollTop;
      var first = ol.querySelector('li[id^="chat-messages-"]');
      ol.insertBefore(renderRange(start, lo - 1), first);
      lo = start;
      scroller.scrollTop = prevScrollTop + (scroller.scrollHeight - prevScrollHeight);
      var excess = hi - lo + 1 - MAX_DOM_ITEMS;
      if (excess > 0) {
        removeLast(excess);
        hi -= excess;
      }
      syncMarkers();
      logOp('older');
      isLoading = false;
    }, randomDelay());
  }

  function loadNewer() {
    if (isLoading || hi >= ALL_MESSAGES.length - 1) return;
    isLoading = true;
    var g = generation;
    setTimeout(function () {
      if (g !== generation) return;
      var end = Math.min(ALL_MESSAGES.length - 1, hi + PAGE_SIZE);
      ol.appendChild(renderRange(hi + 1, end));
      hi = end;
      var excess = hi - lo + 1 - MAX_DOM_ITEMS;
      if (excess > 0) {
        var prevScrollHeight = scroller.scrollHeight;
        var prevScrollTop = scroller.scrollTop;
        removeFirst(excess);
        lo += excess;
        scroller.scrollTop = prevScrollTop - (prevScrollHeight - scroller.scrollHeight);
      }
      syncMarkers();
      logOp('newer');
      isLoading = false;
    }, randomDelay());
  }

  function showBeginningMarker() {
    var marker = document.createElement('li');
    marker.className = 'message_d5deea';
    var emptyDiv = document.createElement('div');
    emptyDiv.className = 'emptyChannel_c19a55';
    if (MOCK_KIND === 'channel') {
      emptyDiv.innerHTML = '<h2>Welcome to <strong>#general</strong>!</h2><p>This is the start of the #general channel.</p>';
    } else {
      emptyDiv.innerHTML = '<h2>This is the beginning of your direct message history with <strong>@alice</strong>.</h2><p>Messages sent here are only visible to you and alice.</p>';
    }
    marker.appendChild(emptyDiv);
    ol.insertBefore(marker, ol.firstChild);
  }

  function showJumpToPresentBar() {
    if (document.querySelector('.jumpToPresentBar_c19a55')) return;
    var bar = document.createElement('div');
    bar.className = 'jumpToPresentBar_c19a55';
    var label = document.createElement('span');
    label.textContent = "You're viewing older messages";
    var btn = document.createElement('button');
    btn.textContent = 'Jump To Present';
    btn.addEventListener('click', jumpToPresent);
    bar.appendChild(label);
    bar.appendChild(btn);
    scroller.parentNode.appendChild(bar);
  }

  function hideJumpToPresentBar() {
    var bar = document.querySelector('.jumpToPresentBar_c19a55');
    if (bar) bar.parentNode.removeChild(bar);
  }

  function jumpToPresent() {
    var g = ++generation;
    isLoading = true;
    setTimeout(function () {
      if (g !== generation) return;
      renderInitial();
      logOp('jump');
      isLoading = false;
    }, randomDelay());
  }

  function checkEdges() {
    if (scroller.scrollTop < 200) loadOlder();
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200) loadNewer();
  }
  scroller.addEventListener('scroll', checkEdges);
  window.__mockState = function () { return { lo: lo, hi: hi, isLoading: isLoading, top: scroller.scrollTop }; };
  setInterval(checkEdges, 300);


  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  renderInitial();

  // If the initial render didn't fill the viewport, load more
  if (scroller.scrollHeight <= scroller.clientHeight + 200) {
    loadOlder();
  }
})();
