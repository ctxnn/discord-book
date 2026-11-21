/**
 * Discord Book — DOM scraper content script.
 *
 * Loaded on https://discord.com/*.  Exposes exactly one global:
 *   window.DiscordBookScraper = { getChatInfo, listVisibleAuthors, scrape }
 *
 * Reads the page DOM only; never touches the Discord API, tokens,
 * localStorage, webpack chunks, or internal modules.
 */

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const DISCORD_EPOCH = 1420070400000;

  function snowflakeToTs(id) {
    return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH).toISOString();
  }

  function snowflakeToMs(id) {
    return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  }

  /** Return the nearest ancestor of `el` matching `predicate`. */
  function closest(el, predicate) {
    while (el) {
      if (predicate(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** Find the scrollable ancestor of the message list. */
  function findScroller(ol) {
    let el = ol.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** Minimal sleep. */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // -----------------------------------------------------------------------
  // Whitelist sanitizer (produces clean HTML + plain text)
  // -----------------------------------------------------------------------

  const ALLOWED_TAGS = new Set([
    'STRONG', 'EM', 'U', 'S', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
    'BR', 'P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'A',
    'SPAN', 'IMG'
  ]);

  const ALLOWED_ATTRS_BY_TAG = {
    A: new Set(['href']),
    SPAN: new Set(['class']),
    IMG: new Set(['class', 'src', 'alt'])
  };

  const ALLOWED_SPAN_CLASSES = new Set(['mention', 'spoiler', 'timestamp']);

  const ALLOWED_IMG_CLASSES = new Set(['emoji']);

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return { html: escapeText(node.textContent), text: node.textContent };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return { html: '', text: '' };
    }

    var tag = node.tagName.toUpperCase();

    // Edited marker: skip it entirely
    if (tag === 'SPAN' && node.className && typeof node.className === 'string') {
      var cls = node.className;
      if (cls.indexOf('edited_') !== -1 || cls.indexOf('edited') !== -1) {
        return { html: '', text: '' };
      }
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: process children only
      var uHtml = '';
      var uText = '';
      for (var c = node.firstChild; c; c = c.nextSibling) {
        var s = sanitizeNode(c);
        uHtml += s.html;
        uText += s.text;
      }
      return { html: uHtml, text: uText };
    }

    // Build opening tag with allowed attributes
    var open = '<' + tag.toLowerCase();
    var attrs = ALLOWED_ATTRS_BY_TAG[tag];
    if (attrs) {
      for (var ai = 0; ai < node.attributes.length; ai++) {
        var attr = node.attributes[ai];
        var aname = attr.name.toLowerCase();
        if (!attrs.has(aname)) continue;

        if (tag === 'SPAN' && aname === 'class') {
          // Only keep whitelisted classes
          var classes = attr.value.split(/\s+/);
          var kept = [];
          for (var ci = 0; ci < classes.length; ci++) {
            if (ALLOWED_SPAN_CLASSES.has(classes[ci])) kept.push(classes[ci]);
          }
          if (kept.length === 0) continue;
          open += ' class="' + escapeAttr(kept.join(' ')) + '"';
        } else if (tag === 'IMG' && aname === 'class') {
          var iclasses = attr.value.split(/\s+/);
          var ikept = [];
          for (var ici = 0; ici < iclasses.length; ici++) {
            if (ALLOWED_IMG_CLASSES.has(iclasses[ici])) ikept.push(iclasses[ici]);
          }
          if (ikept.length === 0) continue;
          open += ' class="' + escapeAttr(ikept.join(' ')) + '"';
        } else {
          open += ' ' + aname + '="' + escapeAttr(attr.value) + '"';
        }
      }
    }
    open += '>';

    // Void elements
    if (tag === 'BR' || tag === 'IMG') {
      return { html: open, text: tag === 'IMG' ? (node.alt || '') : '\n' };
    }

    // Process children
    var cHtml = '';
    var cText = '';
    for (var cc = node.firstChild; cc; cc = cc.nextSibling) {
      var cs = sanitizeNode(cc);
      cHtml += cs.html;
      cText += cs.text;
    }

    var close = '</' + tag.toLowerCase() + '>';

    // Collapse pre/code text
    if (tag === 'PRE') {
      cHtml = '<pre>' + escapeText(node.textContent || '') + '</pre>';
      cText = node.textContent || '';
    }
    if (tag === 'CODE' && closest(node, function (e) { return e.tagName === 'PRE'; })) {
      // code inside pre: already handled by pre above
      return { html: escapeText(node.textContent || ''), text: node.textContent || '' };
    }

    return { html: open + cHtml + close, text: cText };
  }

  function escapeText(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitizeHtml(rootEl) {
    var html = '';
    var text = '';
    for (var c = rootEl.firstChild; c; c = c.nextSibling) {
      var s = sanitizeNode(c);
      html += s.html;
      text += s.text;
    }
    // Collapse whitespace in text
    text = text.replace(/\s+/g, ' ').trim();
    // Trim trailing whitespace in html
    html = html.trim();
    return { html: html, text: text };
  }

  // -----------------------------------------------------------------------
  // Message extraction
  // -----------------------------------------------------------------------

  function extractMessage(li) {
    var idMatch = li.id.match(/^chat-messages-\d+-(\d+)$/);
    if (!idMatch) return null;
    var id = idMatch[1];

    var ts = snowflakeToTs(id);

    // Author
    var author = null;
    var headerEl = li.querySelector('h3');
    if (headerEl) {
      var usernameSpan = headerEl.querySelector('span[id^="message-username-"] span[class*="username_"]');
      var avatarImg = headerEl.querySelector('img[class*="avatar_"]');
      if (usernameSpan) {
        var name = (usernameSpan.getAttribute('data-text') || usernameSpan.textContent || '').trim();
        var avatarUrl = null;
        var userId = null;
        if (avatarImg) {
          avatarUrl = avatarImg.src || null;
          // Extract user id from avatar URL: /avatars/<userId>/...
          var avMatch = avatarUrl.match(/\/avatars\/(\d+)\//);
          if (avMatch) userId = avMatch[1];
        }
        author = { name: name, id: userId, avatar: avatarUrl };
      }
    }

    // System message detection
    var isSystem = false;
    if (li.querySelector('[class*="systemMessage_"]') || li.querySelector('[class*="systemMessage"]')) {
      isSystem = true;
    }
    // Also check: has content_ but no message-content id
    var contentDiv = li.querySelector('div[id^="message-content-"]');
    if (!contentDiv && !isSystem) {
      var contentEl = li.querySelector('[class*="content_"]');
      if (contentEl && contentEl.textContent && contentEl.textContent.trim()) {
        isSystem = true;
      }
    }

    // Body
    var html = '';
    var text = '';
    var edited = false;

    if (contentDiv) {
      var editedEl = contentDiv.querySelector('[class*="edited_"]');
      if (editedEl) edited = true;
      // Also check for "(edited)" text
      if (!edited && contentDiv.textContent && contentDiv.textContent.indexOf('(edited)') !== -1) {
        edited = true;
      }

      // Clone for sanitization
      var clone = contentDiv.cloneNode(true);
      // Remove edited spans from clone before sanitizing
      var editedSpans = clone.querySelectorAll('[class*="edited_"]');
      for (var ei = 0; ei < editedSpans.length; ei++) {
        editedSpans[ei].remove();
      }

      // Handle mentions: keep as span.mention
      var mentions = clone.querySelectorAll('[class*="mention"]');
      for (var mi = 0; mi < mentions.length; mi++) {
        mentions[mi].setAttribute('class', 'mention');
        // Remove non-whitelisted attributes
        while (mentions[mi].attributes.length > 1) {
          var mattr = mentions[mi].attributes[1];
          mentions[mi].removeAttribute(mattr.name);
        }
      }

      // Handle spoilers
      var spoilers = clone.querySelectorAll('[class*="spoilerContent_"], [class*="spoilerContent"], [class*="spoiler_"]');
      for (var si = 0; si < spoilers.length; si++) {
        spoilers[si].setAttribute('class', 'spoiler');
        while (spoilers[si].attributes.length > 1) {
          var sattr = spoilers[si].attributes[1];
          spoilers[si].removeAttribute(sattr.name);
        }
      }

      // Handle timestamps
      var timestamps = clone.querySelectorAll('[class*="timestamp_"]');
      for (var ti = 0; ti < timestamps.length; ti++) {
        timestamps[ti].setAttribute('class', 'timestamp');
        while (timestamps[ti].attributes.length > 1) {
          var tattr = timestamps[ti].attributes[1];
          timestamps[ti].removeAttribute(tattr.name);
        }
      }

      // Handle custom emoji images
      var emojiImgs = clone.querySelectorAll('img.emoji, img[data-type="emoji"]');
      for (var emi = 0; emi < emojiImgs.length; emi++) {
        var eImg = emojiImgs[emi];
        var alt = eImg.alt || eImg.getAttribute('data-name') || '';
        eImg.setAttribute('class', 'emoji');
        eImg.setAttribute('alt', alt);
        // Keep src
        while (eImg.attributes.length > 3) {
          var eattr = eImg.attributes[3];
          eImg.removeAttribute(eattr.name);
        }
      }

      // Handle unicode emoji images (Discord renders unicode emoji as <img> with the char in alt)
      var allImgs = clone.querySelectorAll('img');
      for (var aii = 0; aii < allImgs.length; aii++) {
        var aimg = allImgs[aii];
        // If it's already handled as custom emoji, skip
        if (aimg.classList.contains('emoji')) continue;
        // Check if it looks like a unicode emoji (alt is a single or few unicode chars, not a :name:)
        var aalt = aimg.alt || '';
        if (aalt && !aalt.startsWith(':') && !aalt.startsWith('http') && aalt.length <= 4) {
          // This is likely a unicode emoji rendered as img — replace with alt text
          var textNode = document.createTextNode(aalt);
          aimg.parentNode.replaceChild(textNode, aimg);
        }
      }

      var sanitized = sanitizeHtml(clone);
      html = sanitized.html;
      text = sanitized.text;
    } else if (isSystem) {
      // System messages: grab the text from the content area
      var sysContent = li.querySelector('[class*="content_"]');
      if (sysContent) {
        text = (sysContent.textContent || '').replace(/\s+/g, ' ').trim();
        html = escapeText(text);
      }
    }

    // Reply
    var reply = null;
    var replyCtx = li.querySelector('div[id^="message-reply-context-"]');
    if (replyCtx) {
      var replyAuthor = replyCtx.querySelector('[class*="username_"]');
      var replyText = replyCtx.querySelector('[class*="repliedTextContent_"]');
      var replyAuthorName = replyAuthor ? (replyAuthor.getAttribute('data-text') || replyAuthor.textContent || '').trim() : '';
      var replySnippet = replyText ? (replyText.textContent || '').trim() : '';
      reply = { author: replyAuthorName, text: replySnippet };
    }

    // Attachments
    var attachments = [];
    var accessoriesDiv = li.querySelector('div[id^="message-accessories-"]');
    if (accessoriesDiv) {
      // Image attachments
      var imgLinks = accessoriesDiv.querySelectorAll('a[class*="originalLink_"]');
      for (var ili = 0; ili < imgLinks.length; ili++) {
        var il = imgLinks[ili];
        var imgEl = il.querySelector('img') || il;
        attachments.push({
          type: 'image',
          url: il.href || '',
          name: (imgEl.alt || il.href || '').split('/').pop().split('?')[0] || 'image',
          width: parseInt(imgEl.getAttribute('width') || imgEl.style.width) || null,
          height: parseInt(imgEl.getAttribute('height') || imgEl.style.height) || null
        });
      }

      // Also check for images inside imageWrapper/imageContainer
      var wrappers = accessoriesDiv.querySelectorAll('[class*="imageWrapper_"] img, [class*="imageContainer_"] img');
      for (var wi = 0; wi < wrappers.length; wi++) {
        var wimg = wrappers[wi];
        var wurl = wimg.src || '';
        // Avoid duplicates from originalLink
        var isDup = false;
        for (var dai = 0; dai < attachments.length; dai++) {
          if (attachments[dai].url === wurl) { isDup = true; break; }
        }
        if (!isDup && wurl) {
          attachments.push({
            type: 'image',
            url: wurl,
            name: (wimg.alt || wurl).split('/').pop().split('?')[0] || 'image',
            width: parseInt(wimg.getAttribute('width') || wimg.style.width) || null,
            height: parseInt(wimg.getAttribute('height') || wimg.style.height) || null
          });
        }
      }

      // File attachments
      var fileAttachments = accessoriesDiv.querySelectorAll('[class*="attachment_"]');
      for (var fai = 0; fai < fileAttachments.length; fai++) {
        var fa = fileAttachments[fai];
        var fileLink = fa.querySelector('a[class*="fileNameLink_"]') || fa.querySelector('a[href*="cdn.discordapp.com/attachments"]');
        var sizeEl = fa.querySelector('[class*="metadata_"]');
        attachments.push({
          type: 'file',
          url: fileLink ? fileLink.href : '',
          name: fileLink ? (fileLink.textContent || '').trim() : '',
          size: sizeEl ? (sizeEl.textContent || '').trim() : null
        });
      }

      // Video attachments
      var videos = accessoriesDiv.querySelectorAll('video');
      for (var vi = 0; vi < videos.length; vi++) {
        var v = videos[vi];
        attachments.push({
          type: 'video',
          url: v.src || '',
          name: (v.src || '').split('/').pop().split('?')[0] || 'video',
          poster: v.getAttribute('poster') || null
        });
      }

      // Stickers
      var stickers = [];
      var stickerEls = accessoriesDiv.querySelectorAll('img[class*="sticker"], [class*="stickerAsset_"] img');
      for (var sti = 0; sti < stickerEls.length; sti++) {
        var st = stickerEls[sti];
        stickers.push({
          name: st.alt || st.getAttribute('aria-label') || '',
          url: st.src || ''
        });
      }
    }

    // Also check for stickers outside accessories
    var stickerEls2 = li.querySelectorAll('img[class*="sticker"], [class*="stickerAsset_"] img');
    for (var sti2 = 0; sti2 < stickerEls2.length; sti2++) {
      var st2 = stickerEls2[sti2];
      var isDupSt = false;
      for (var dsi = 0; dsi < stickers.length; dsi++) {
        if (stickers[dsi].url === st2.src) { isDupSt = true; break; }
      }
      if (!isDupSt && st2.src) {
        stickers.push({
          name: st2.alt || st2.getAttribute('aria-label') || '',
          url: st2.src
        });
      }
    }

    // Embeds
    var embeds = [];
    if (accessoriesDiv) {
      var embedEls = accessoriesDiv.querySelectorAll('article[class*="embed"], [class*="embedFull_"]');
      for (var eei = 0; eei < embedEls.length; eei++) {
        var embed = embedEls[eei];
        var providerEl = embed.querySelector('[class*="embedProvider_"]');
        var authorEl = embed.querySelector('[class*="embedAuthor_"]');
        var titleEl = embed.querySelector('[class*="embedTitle_"]');
        var descEl = embed.querySelector('[class*="embedDescription_"]');
        var imageEl = embed.querySelector('[class*="embedImage_"] img, [class*="embedThumbnail_"] img');

        var embedColor = null;
        var style = embed.getAttribute('style') || '';
        var borderMatch = style.match(/border-left(?:-color)?:\s*([^;]+)/);
        if (borderMatch) embedColor = borderMatch[1].trim();

        embeds.push({
          provider: providerEl ? (providerEl.textContent || '').trim() : null,
          author: authorEl ? (authorEl.textContent || '').trim() : null,
          title: titleEl ? (titleEl.textContent || '').trim() : null,
          description: descEl ? (descEl.textContent || '').trim() : null,
          url: titleEl ? (titleEl.href || null) : null,
          image: imageEl ? (imageEl.src || null) : null,
          color: embedColor
        });
      }
    }

    // Reactions
    var reactions = [];
    var reactionsDiv = li.querySelector('div[id^="message-reactions-"]');
    if (reactionsDiv) {
      var reactionItems = reactionsDiv.querySelectorAll('[class*="reaction_"]');
      for (var ri = 0; ri < reactionItems.length; ri++) {
        var ritem = reactionItems[ri];
        var remoji = ritem.querySelector('img');
        var rcount = ritem.querySelector('[class*="reactionCount_"]');
        var emojiAlt = remoji ? (remoji.alt || '') : '';
        var emojiSrc = remoji ? (remoji.src || null) : null;
        // Determine if custom or unicode
        var isCustomEmoji = emojiSrc && emojiSrc.indexOf('/emojis/') !== -1;
        reactions.push({
          emoji: isCustomEmoji ? null : emojiAlt,
          emojiUrl: isCustomEmoji ? emojiSrc : null,
          count: rcount ? parseInt(rcount.textContent, 10) || 0 : 0
        });
      }
    }

    return {
      id: id,
      ts: ts,
      author: author,
      html: html,
      text: text,
      edited: edited,
      reply: reply,
      attachments: attachments,
      embeds: embeds,
      stickers: stickers,
      reactions: reactions,
      system: isSystem
    };
  }

  // -----------------------------------------------------------------------
  // Chat info
  // -----------------------------------------------------------------------

  function getChatInfo() {
    var url = window.location.href;
    var pathMatch = url.match(/\/channels\/(\d+|@me)\/(\d+)/);

    var guildId, channelId, kind, title, serverName;

    if (pathMatch) {
      guildId = pathMatch[1];
      channelId = pathMatch[2];
    } else {
      // Not a Discord URL (e.g. file:// for testing). Derive from the DOM.
      var ol = document.querySelector('ol[data-list-id="chat-messages"]');
      if (!ol) return null;
      var firstLi = ol.querySelector('li[id^="chat-messages-"]');
      if (firstLi) {
        var idMatch = firstLi.id.match(/^chat-messages-(\d+)-/);
        channelId = idMatch ? idMatch[1] : '0';
      } else {
        channelId = '0';
      }
      var docTitle0 = document.title || '';
      if (docTitle0.indexOf('#') !== -1) {
        guildId = '987654321098765432';
      } else {
        guildId = '@me';
      }
    }

    kind = 'channel';
    title = '';
    serverName = null;

    var headerTitle = document.querySelector('section[aria-label="Channel header"] h1, section[aria-label="Channel header"] [class*="title_"]');
    if (headerTitle) {
      title = (headerTitle.textContent || '').trim();
    }

    var parts = (document.title || '').replace(/^\(\d+\)\s*/, '').replace(/^•\s*/, '').split(' | ');
    if (parts[0] === 'Discord') parts.shift();
    if (!title && parts.length >= 1) {
      title = parts[0];
    }
    if (guildId !== '@me' && parts.length >= 2) {
      serverName = parts[parts.length - 1];
    }

    if (guildId === '@me') {
      if (title.indexOf(',') !== -1) {
        kind = 'group';
      } else {
        var groupIcon = document.querySelector('[class*="groupIcon"], [class*="channelIcon"][class*="group"]');
        if (groupIcon) {
          kind = 'group';
        } else {
          kind = 'dm';
        }
      }
    } else {
      kind = 'channel';
    }

    if (!serverName && guildId !== '@me') {
      var serverHeader = document.querySelector('nav[aria-label$="(server)"] header h2');
      if (serverHeader) {
        serverName = (serverHeader.textContent || '').trim();
      }
    }

    return {
      guildId: guildId,
      channelId: channelId,
      kind: kind,
      title: title,
      serverName: serverName,
      url: url.split('?')[0]
    };
  }

  // -----------------------------------------------------------------------
  // Visible authors
  // -----------------------------------------------------------------------

  function listVisibleAuthors() {
    var seen = {};
    var authors = [];
    var lis = document.querySelectorAll('li[id^="chat-messages-"]');
    for (var i = 0; i < lis.length; i++) {
      var header = lis[i].querySelector('h3');
      if (!header) continue;
      var usernameSpan = header.querySelector('span[id^="message-username-"] span[class*="username_"]');
      if (!usernameSpan) continue;
      var name = (usernameSpan.getAttribute('data-text') || usernameSpan.textContent || '').trim();
      var avatarImg = header.querySelector('img[class*="avatar_"]');
      var id = null;
      if (avatarImg) {
        var avMatch = (avatarImg.src || '').match(/\/avatars\/(\d+)\//);
        if (avMatch) id = avMatch[1];
      }
      if (name && !seen[name]) {
        seen[name] = true;
        authors.push({ name: name, id: id });
      }
    }
    return authors;
  }

  // -----------------------------------------------------------------------
  // Scrape
  // -----------------------------------------------------------------------

  async function scrape(opts) {
    opts = opts || {};
    var fromDate = opts.fromDate || null;
    var maxMessages = opts.maxMessages || Infinity;
    var onProgress = opts.onProgress || function () {};
    var signal = opts.signal || null;

    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    var ol = document.querySelector('ol[data-list-id="chat-messages"]');
    if (!ol) {
      return { messages: [], complete: false, participants: [] };
    }

    var scroller = findScroller(ol);
    if (!scroller) {
      return { messages: [], complete: false, participants: [] };
    }

    var collected = new Map();
    var complete = false;
    var oldestTs = null;

    function checkComplete() {
      // Only search within the scroller, not the entire document.
      // Real Discord has [class*="header_"] elements in sidebars, popouts,
      // and server welcome screens that would false-positive.
      //
      // Look for the empty-channel welcome marker inside the scroller
      // and verify it sits before the oldest visible message in DOM order.

      var candidates = scroller.querySelectorAll('[class*="emptyChannel"]');
      for (var ci = 0; ci < candidates.length; ci++) {
        var el = candidates[ci];
        var hText = (el.textContent || '').toLowerCase();
        if (
          hText.indexOf('beginning of your direct message history') !== -1 ||
          hText.indexOf('this is the start of the') !== -1 ||
          hText.indexOf('welcome to #') !== -1 ||
          hText.indexOf('this is the beginning') !== -1
        ) {
          // Confirm the marker is above the first message li in DOM order.
          // If there are no messages at all the channel is empty → complete.
          var firstMsg = ol.querySelector('li[id^="chat-messages-"]');
          if (!firstMsg) return true;
          // el is before firstMsg when firstMsg follows el
          if (el.compareDocumentPosition(firstMsg) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return true;
          }
          // Otherwise the marker is somewhere else in the scroller
          // (e.g. after messages) — not the real beginning.
        }
      }

      // Fallback: check for header elements whose text matches, but only
      // those that are direct ancestors/descendants of the scroller AND
      // appear before the first message li.
      var headerCandidates = scroller.querySelectorAll('[class*="header_"]');
      for (var hi = 0; hi < headerCandidates.length; hi++) {
        var hEl = headerCandidates[hi];
        var ht = (hEl.textContent || '').toLowerCase();
        if (
          ht.indexOf('beginning of your direct message history') !== -1 ||
          ht.indexOf('this is the start of the') !== -1 ||
          ht.indexOf('welcome to #') !== -1
        ) {
          var firstMsg2 = ol.querySelector('li[id^="chat-messages-"]');
          if (!firstMsg2) return true;
          if (hEl.compareDocumentPosition(firstMsg2) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return true;
          }
        }
      }

      return false;
    }

    function harvestMessages() {
      var lis = ol.querySelectorAll('li[id^="chat-messages-"]');
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        if (li.getAttribute('role') === 'separator') continue;
        if (li.id && li.id.indexOf('---new-messages-bar') !== -1) continue;

        var msg = extractMessage(li);
        if (!msg) continue;

        if (!collected.has(msg.id)) {
          collected.set(msg.id, msg);
        }
      }

      if (collected.size > 0) {
        var oldest = null;
        collected.forEach(function (m) {
          var ms = snowflakeToMs(m.id);
          if (oldest === null || ms < oldest) oldest = ms;
        });
        if (oldest !== null) {
          oldestTs = new Date(oldest).toISOString();
        }
      }
    }

    function sortMessages() {
      var msgs = Array.from(collected.values());
      msgs.sort(function (a, b) {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      return msgs;
    }

    function resolveAuthors(messages) {
      // For grouped follow-ups with null author, inherit from the
      // immediately previous message.  System messages (joins, pins,
      // calls) carry no author and break the visual grouping chain —
      // a message after a system message always has its own header
      // in real Discord, so we never inherit across one.
      for (var i = 0; i < messages.length; i++) {
        if (messages[i].system) continue;
        if (messages[i].author === null && i > 0) {
          var prev = messages[i - 1];
          if (!prev.system && prev.author) {
            messages[i].author = {
              name: prev.author.name,
              id: prev.author.id,
              avatar: prev.author.avatar
            };
          }
        }
      }
    }

    function computeParticipants(messages) {
      var counts = {};
      var details = {};
      for (var i = 0; i < messages.length; i++) {
        var author = messages[i].author;
        if (!author || !author.name) continue;
        var key = author.id || author.name;
        if (!counts[key]) {
          counts[key] = 0;
          details[key] = { name: author.name, id: author.id, avatar: author.avatar };
        }
        counts[key]++;
      }
      var participants = Object.keys(counts).map(function (k) {
        return {
          name: details[k].name,
          id: details[k].id,
          avatar: details[k].avatar,
          count: counts[k]
        };
      });
      participants.sort(function (a, b) { return b.count - a.count; });
      return participants;
    }

    function finish() {
      var messages = sortMessages();
      resolveAuthors(messages);

      if (fromDate) {
        var fromMs = fromDate.getTime();
        messages = messages.filter(function (m) {
          return snowflakeToMs(m.id) >= fromMs;
        });
      }

      if (messages.length > maxMessages) {
        messages = messages.slice(messages.length - maxMessages);
      }

      var participants = computeParticipants(messages);

      onProgress({
        collected: messages.length,
        oldestTs: messages.length > 0 ? messages[0].ts : null,
        phase: 'finishing'
      });

      return {
        messages: messages,
        complete: complete,
        participants: participants
      };
    }

    function shouldStop() {
      if (signal && signal.aborted) return true;
      if (collected.size >= maxMessages * 2) return true;
      if (fromDate) {
        var fromMs = fromDate.getTime();
        var allOlder = true;
        collected.forEach(function (m) {
          if (snowflakeToMs(m.id) >= fromMs) allOlder = false;
        });
        if (allOlder && collected.size > 0) return true;
      }
      return false;
    }

    // Wait for new messages to appear in the DOM after scrolling
    function waitForNewMessages(prevCount, timeoutMs) {
      return new Promise(function (res) {
        var start = Date.now();
        var observer = null;
        var pollId = null;
        var done = false;

        function resolveWait() {
          if (done) return;
          done = true;
          if (observer) observer.disconnect();
          if (pollId) clearTimeout(pollId);
          res();
        }

        function poll() {
          if (done) return;
          harvestMessages();
          if (collected.size > prevCount) {
            // New messages found — but wait a beat for the page to settle
            // before the next scroll, so the virtualizer's isLoading gate opens.
            if (pollId) clearTimeout(pollId);
            pollId = setTimeout(resolveWait, 400);
            return;
          }
          if (Date.now() - start >= timeoutMs) {
            resolveWait();
            return;
          }
          pollId = setTimeout(poll, 350);
        }

        try {
          observer = new MutationObserver(function (mutations) {
            for (var mi = 0; mi < mutations.length; mi++) {
              var mut = mutations[mi];
              if (mut.type === 'childList' && mut.addedNodes.length > 0) {
                for (var ni = 0; ni < mut.addedNodes.length; ni++) {
                  var node = mut.addedNodes[ni];
                  if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.matches && node.matches('li[id^="chat-messages-"]')) {
                      // DOM changed — let polling pick up the new count after settle
                      return;
                    }
                    if (node.querySelectorAll) {
                      var innerLis = node.querySelectorAll('li[id^="chat-messages-"]');
                      if (innerLis.length > 0) return;
                    }
                  }
                }
              }
            }
          });
          observer.observe(ol, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }

        poll();
      });
    }

    // Main scroll loop
    var noNewCount = 0;
    var NO_NEW_MSG_LIMIT = 10;
    var MAX_SCROLL_ATTEMPTS = 300;

    // Phase 0: scroll to the bottom first so we capture any messages
    // below the current viewport (the user may have scrolled up).
    // Loop until the DOM stabilises — the virtualizer may need several
    // round-trips to reload every trimmed newest message.
    for (var bottomPass = 0; bottomPass < 8; bottomPass++) {
      var beforeBottom = collected.size;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(500);
      harvestMessages();
      // Repeat while new messages are still appearing
      if (collected.size === beforeBottom && bottomPass >= 2) break;
    }

    onProgress({ collected: collected.size, oldestTs: oldestTs, phase: 'scrolling' });

    for (var attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      var prevCount = collected.size;

      // Check completion conditions
      if (checkComplete()) {
        complete = true;
        return finish();
      }

      if (shouldStop()) {
        if (!(fromDate || collected.size >= maxMessages)) {
          complete = checkComplete();
        }
        return finish();
      }

      // Scroll to top to trigger loading of older messages
      var prevScrollTop = scroller.scrollTop;
      scroller.scrollTop = 0;

      if (scroller.scrollTop === 0 && prevScrollTop === 0 && collected.size > 0) {
        // Already at top — wait for potential late loads
        await sleep(1500);
        harvestMessages();
        if (checkComplete()) {
          complete = true;
          return finish();
        }
        if (collected.size === prevCount) {
          noNewCount++;
          if (noNewCount >= NO_NEW_MSG_LIMIT) {
            complete = checkComplete();
            return finish();
          }
        } else {
          noNewCount = 0;
        }
        onProgress({ collected: collected.size, oldestTs: oldestTs, phase: 'scrolling' });
        continue;
      }

      // Wait for new messages to load (virtualized list)
      await waitForNewMessages(prevCount, 2500);
      harvestMessages();

      if (collected.size === prevCount) {
        noNewCount++;
        if (noNewCount >= NO_NEW_MSG_LIMIT) {
          complete = checkComplete();
          return finish();
        }
      } else {
        noNewCount = 0;
      }

      onProgress({ collected: collected.size, oldestTs: oldestTs, phase: 'scrolling' });
    }

    // Ran out of attempts
    complete = checkComplete();
    return finish();
  }

  // -----------------------------------------------------------------------
  // Exports
  // -----------------------------------------------------------------------

  window.DiscordBookScraper = {
    getChatInfo: getChatInfo,
    listVisibleAuthors: listVisibleAuthors,
    scrape: scrape
  };
})();
