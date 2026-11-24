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
    let fallback = null;
    for (let el = ol.parentElement; el && el !== document.body; el = el.parentElement) {
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      fallback = fallback || el;
      if (el.scrollHeight > el.clientHeight + 4) return el;
    }
    return fallback;
  }

  /** The author's picture: Discord puts it beside the name, not inside it. */
  function rowAvatar(row) {
    var imgs = row.querySelectorAll('img[class*="avatar_"]');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].closest('[id^="message-reply-context-"], [class*="repliedMessage"], [id^="message-accessories-"], [id^="message-reactions-"]')) continue;
      return imgs[i];
    }
    return null;
  }

  /** User id from /avatars/<id>/… or a server avatar's /users/<id>/avatars/…. */
  function userIdFromAvatar(url) {
    var m = String(url || '').match(/\/(?:users\/(\d+)\/avatars|avatars\/(\d+))\//);
    return m ? (m[1] || m[2]) : null;
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
      var avatarImg = rowAvatar(li);
      if (usernameSpan) {
        var name = (usernameSpan.getAttribute('data-text') || usernameSpan.textContent || '').trim();
        var avatarUrl = avatarImg ? (avatarImg.src || null) : null;
        author = { name: name, id: userIdFromAvatar(avatarUrl), avatar: avatarUrl };
      }
    }

    // System message detection
    var isSystem = false;
    if (li.querySelector('[class*="systemMessage_"]') || li.querySelector('[class*="systemMessage"]')) {
      isSystem = true;
    }
    // Also check: has content_ but no message-content id
    // A reply also holds a preview of the original message, with that
    // message's own message-content id; take only this message's content.
    var contentDiv = li.querySelector('#message-content-' + id);
    if (!contentDiv) {
      var contentDivs = li.querySelectorAll('div[id^="message-content-"]');
      for (var cdi = 0; cdi < contentDivs.length && !contentDiv; cdi++) {
        if (!contentDivs[cdi].closest('[id^="message-reply-context-"], [class*="repliedMessage"], [id^="message-accessories-"]')) contentDiv = contentDivs[cdi];
      }
    }
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
    var replyCtx = li.querySelector('div[id^="message-reply-context-"], [class*="repliedMessage_"]');
    if (replyCtx) {
      var replyAuthor = replyCtx.querySelector('[class*="username_"]');
      var replyText = replyCtx.querySelector('[id^="message-content-"], [class*="repliedTextContent_"], [class*="repliedTextPreview_"]');
      var replyAuthorName = replyAuthor ? (replyAuthor.getAttribute('data-text') || replyAuthor.textContent || '').trim().replace(/^@/, '') : '';
      var replySnippet = replyText ? (replyText.textContent || '').trim() : '';
      reply = { author: replyAuthorName, text: replySnippet };
    }

    // Attachments
    var attachments = [];
    var stickers = [];
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
      var ol = document.querySelector('[data-list-id^="chat-messages"]');
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
      var avatarImg = rowAvatar(lis[i]);
      var id = avatarImg ? userIdFromAvatar(avatarImg.src) : null;
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

  var LIST_SELECTOR = '[data-list-id^="chat-messages"]';
  var ROW_ID = /^chat-messages-(\d+)-(\d+)$/;
  var STEP_MS = 250;
  var BEGINNING_TEXT = /beginning of your direct message history|this is the beginning of|this is the start of the|welcome to #|welcome to the beginning/;

  // When Discord does not load the next page, each retry scrolls away from
  // the edge (dwell), comes back to a different depth and waits longer
  // (settle). Working Discord exporters page through history the same way.
  var PAGINATION_ATTEMPTS = [
    { depth: 0.65, dwell: 800, settle: 800 },
    { depth: 0.32, dwell: 1200, settle: 1600 },
    { depth: 0.8, dwell: 2000, settle: 3200 },
    { depth: 0.9, dwell: 3200, settle: 6400 },
    { depth: 0.96, dwell: 4800, settle: 12000 },
    { depth: 0.5, dwell: 12000, settle: 12000 },
    { depth: 0.65, dwell: 24000, settle: 12000 }
  ];

  function readView() {
    var root = document.querySelector(LIST_SELECTOR);
    var view = { root: root, scroller: null, rows: [], welcome: null };
    if (!root) return view;
    view.scroller = findScroller(root);
    var els = root.querySelectorAll('[id^="chat-messages-"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var m = el.id.match(ROW_ID);
      if (!m || (el.parentElement && el.parentElement.closest('[id^="chat-messages-"]'))) continue;
      if (m[1] === m[2]) view.welcome = el;
      else if (el.getAttribute('role') !== 'separator') view.rows.push(el);
    }
    return view;
  }

  // Discord draws grey skeleton messages past the last loaded message while
  // more history exists in that direction.
  function isPlaceholder(node) {
    return node.matches('[role="progressbar"], [aria-busy="true"], [class*="spinner"]') ||
      !!node.querySelector(':scope > [class*="wrapper_"][class*="cozy_"], :scope > [class*="wrapper_"][class*="compact_"]');
  }

  function placeholdersPast(view, edgeRow, direction) {
    var node = direction < 0 ? view.root.firstElementChild : view.root.lastElementChild;
    while (node && node !== edgeRow && !node.contains(edgeRow)) {
      if (isPlaceholder(node)) return true;
      node = direction < 0 ? node.nextElementSibling : node.previousElementSibling;
    }
    return false;
  }

  function hasBeginning(view) {
    if (view.welcome) return true;
    try {
      if (view.root.querySelector(':scope > div:has(> [class*="emptyChannelIcon"]), :scope > [class*="channelBeginning"], :scope > [class*="channelStart"]')) return true;
    } catch (e) { /* :has unsupported */ }
    var first = view.rows[0];
    var candidates = view.scroller.querySelectorAll('[class*="emptyChannel"], [class*="header_"]');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.closest('[id^="chat-messages-"]')) continue;
      if (!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (/emptyChannelIcon/.test(el.getAttribute('class') || '') || BEGINNING_TEXT.test((el.textContent || '').toLowerCase())) return true;
    }
    return false;
  }

  function jumpBar() {
    return document.querySelector('[class*="jumpToPresentBar"]');
  }

  function jumpButton(bar) {
    var buttons = bar.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      if (/jump to present/i.test(buttons[i].textContent || '')) return buttons[i];
    }
    return buttons.length ? buttons[buttons.length - 1] : null;
  }

  function waitingForLatest(view) {
    return view.root.getAttribute('aria-busy') === 'true' ||
      view.scroller.getAttribute('aria-busy') === 'true' ||
      !!jumpBar();
  }

  function edgeOffset(scroller, row, direction) {
    var rect = row.getBoundingClientRect();
    return (direction < 0 ? rect.top : rect.bottom) - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  // One step of asking Discord for the next page past `row`. Discord only
  // fetches when the viewport enters the zone near the loaded edge, so a
  // retry first moves away (re-arming it) and then comes back.
  // Returns false once every attempt has been used for this edge.
  function paginate(scroller, row, direction, st, now, maxAttempts) {
    if (now < st.waitUntil) return true;
    var older = direction < 0;
    var viewport = scroller.clientHeight;
    var edge = edgeOffset(scroller, row, direction);
    var maxTop = Math.max(0, scroller.scrollHeight - viewport);
    if (!st.reenter) {
      if (st.attempts >= maxAttempts) return false;
      var firstAttempt = st.attempts++ === 0;
      var outside = older ? scroller.scrollTop >= edge : scroller.scrollTop + viewport <= edge;
      if (!firstAttempt || !outside) {
        var pivot = older ? Math.min(edge + viewport, maxTop) : Math.max(0, edge - 2 * viewport);
        if (older ? pivot > edge : pivot + viewport < edge) {
          scroller.scrollTop = pivot;
          st.reenter = true;
          st.waitUntil = now + PAGINATION_ATTEMPTS[st.attempts - 1].dwell;
          return true;
        }
      }
    }
    var attempt = PAGINATION_ATTEMPTS[st.attempts - 1];
    var offset = viewport * (older ? attempt.depth : 1 - attempt.depth);
    scroller.scrollTop = Math.max(0, Math.min(edge - offset, maxTop));
    st.reenter = false;
    st.waitUntil = now + attempt.settle;
    return true;
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

  // -----------------------------------------------------------------------
  // Seeking with Discord's own search
  // -----------------------------------------------------------------------

  var SEARCH_INPUT = ['input[aria-label="Search"]', 'input[placeholder="Search"]', '[class*="searchBar"] input[type="text"]', 'input[type="text"][placeholder*="Search" i]'];

  function searchInput() {
    for (var i = 0; i < SEARCH_INPUT.length; i++) {
      var el = document.querySelector(SEARCH_INPUT[i]);
      if (el && !el.closest('[id^="discord-book"]')) return el;
    }
    return null;
  }

  function searchResults() {
    return document.querySelector('[data-list-id="search-results"], [class*="searchResultsWrap"], [class*="searchResults_"]');
  }

  function resultItems() {
    var box = searchResults();
    if (!box) return [];
    var items = box.querySelectorAll('[id^="search-result-"], li[class*="searchResult"], [class*="searchResult_"]');
    return Array.prototype.filter.call(items, function (el) { return !el.parentElement.closest('[id^="search-result-"]'); });
  }

  function jumpLink(item) {
    var buttons = item.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute('aria-label') || '') + ' ' + (buttons[i].textContent || '');
      if (/jump/i.test(label)) return buttons[i];
    }
    return buttons.length ? buttons[buttons.length - 1] : item;
  }

  function typeInto(input, text) {
    input.focus();
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(el) {
    for (var type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  /**
   * Jump the channel straight to a date using Discord's search bar:
   * "in:#channel before:<date>" finds the newest message before it, and
   * clicking that result loads the timeline right there. Saves scrolling
   * through months of newer messages.
   */
  async function seekToDate(channelId, untilMs, signal, onProgress) {
    var input = searchInput();
    if (!input || !channelId) return false;
    var day = new Date(untilMs + 86400000).toISOString().slice(0, 10);
    onProgress('Looking for ' + day + ' in Discord\u2019s search\u2026');
    typeInto(input, 'in:' + channelId + ' before:' + day);
    await sleep(200);
    pressEnter(input);

    var clicked = false;
    var start = Date.now();
    while (Date.now() - start < 15000) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await sleep(400);
      var items = resultItems();
      if (items.length) {
        clicked = true;
        jumpLink(items[0]).click();
        break;
      }
    }
    if (!clicked) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return false;
    }

    var landed = false;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 20000) {
      await sleep(400);
      var view = readView();
      if (!view.rows.length) continue;
      var first = snowflakeToMs(view.rows[0].id.match(ROW_ID)[2]);
      var last = snowflakeToMs(view.rows[view.rows.length - 1].id.match(ROW_ID)[2]);
      // We are there when the shown messages reach back past the date and
      // the window still covers it, so nothing between is skipped.
      if (first <= untilMs + 2 * 86400000 && last >= untilMs - 2 * 86400000) {
        landed = true;
        break;
      }
    }
    await sleep(300);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return landed;
  }

  async function scrape(opts) {
    opts = opts || {};
    var fromMs = opts.fromDate ? opts.fromDate.getTime() : null;
    var maxMessages = opts.maxMessages || Infinity;
    var onProgress = opts.onProgress || function () {};
    var signal = opts.signal || null;
    var untilMs = opts.untilDate ? opts.untilDate.getTime() : null;
    var control = opts.control || null;

    var collected = new Map();
    var oldestMs = null;
    var started = Date.now();
    var trail = [];

    function checkAbort() {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }

    function stopped() {
      return !!(control && control.stop);
    }

    checkAbort();
    if (!readView().root) {
      return { messages: [], complete: false, participants: [], diagnostics: { stopReason: 'no-list', trail: [] } };
    }

    function harvest(view) {
      for (var i = 0; i < view.rows.length; i++) {
        var id = view.rows[i].id.match(ROW_ID)[2];
        if (collected.has(id)) continue;
        var msg = extractMessage(view.rows[i]);
        if (!msg) continue;
        collected.set(id, msg);
        var ms = snowflakeToMs(id);
        if (oldestMs === null || ms < oldestMs) oldestMs = ms;
      }
    }

    function record(direction, action, view) {
      var sc = view && view.scroller;
      trail.push({
        t: Math.round((Date.now() - started) / 100) / 10,
        dir: direction,
        act: action,
        got: collected.size,
        rows: view ? view.rows.length : 0,
        top: sc ? Math.round(sc.scrollTop) : null,
        height: sc ? sc.scrollHeight : null,
        viewport: sc ? sc.clientHeight : null,
        bar: !!jumpBar()
      });
      if (trail.length > 200) trail.shift();
    }

    function progress(phase, note) {
      onProgress({
        collected: collected.size,
        oldestTs: oldestMs === null ? null : new Date(oldestMs).toISOString(),
        phase: phase,
        note: note || ''
      });
    }

    function reachedLimit() {
      if (fromMs !== null && oldestMs !== null && oldestMs < fromMs) return true;
      return collected.size >= maxMessages;
    }

    // Walk the list in one direction until Discord has nothing more to load.
    // The list and its scroller are looked up again on every step, because
    // Discord rebuilds them (for example after Jump to Present).
    async function collect(direction) {
      var states = new Map();
      var signature = '';
      var lastChange = Date.now();
      var settleSince = null;
      var hiddenSince = null;
      var missingSince = null;
      var phase = direction < 0 ? 'scrolling' : 'present';
      for (var step = 0; step < 100000; step++) {
        checkAbort();
        if (stopped()) return 'stopped';
        var now = Date.now();
        // Chrome stops delivering scroll events to background tabs, so
        // Discord loads nothing there. Pause instead of using up retries.
        if (document.hidden) {
          if (hiddenSince === null) {
            hiddenSince = now;
            record(direction, 'hidden', null);
          }
          progress(phase, 'Paused: Discord only loads messages while this tab is on screen. Switch back to it to carry on.');
          await sleep(500);
          continue;
        }
        if (hiddenSince !== null) {
          hiddenSince = null;
          states.clear();
          lastChange = now;
          settleSince = null;
          missingSince = null;
        }
        var view = readView();
        if (!view.scroller || !view.rows.length) {
          if (missingSince === null) missingSince = now;
          record(direction, 'no-list', view);
          if (now - missingSince > 20000) return 'list-missing';
          progress(phase, 'Waiting for Discord to show the messages…');
          await sleep(400);
          continue;
        }
        missingSince = null;
        harvest(view);
        if (direction < 0 && reachedLimit()) return 'limit';

        var sc = view.scroller;
        var atEdge = direction < 0
          ? sc.scrollTop <= 3
          : sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
        var edgeRow = direction < 0 ? view.rows[0] : view.rows[view.rows.length - 1];
        var sig = view.rows[0].id + ':' + edgeRow.id + ':' + Math.round(sc.scrollTop) + ':' + sc.scrollHeight;
        if (sig !== signature) {
          signature = sig;
          lastChange = now;
        }
        var boundary = placeholdersPast(view, edgeRow, direction);
        var note = '';
        var action;

        if (direction < 0 && atEdge && hasBeginning(view)) {
          record(direction, 'beginning', view);
          return 'beginning';
        }
        if (direction > 0 && atEdge && !boundary && !waitingForLatest(view)) {
          if (settleSince === null) settleSince = now;
          if (now - lastChange >= 1500 || now - settleSince >= 10000) {
            record(direction, 'present', view);
            return 'present';
          }
          action = 'settle';
        } else if (boundary || atEdge) {
          settleSince = null;
          var st = states.get(edgeRow.id);
          if (!st) {
            st = { attempts: 0, reenter: false, waitUntil: 0 };
            states.set(edgeRow.id, st);
          }
          var maxAttempts = boundary ? PAGINATION_ATTEMPTS.length : 4;
          if (!paginate(sc, edgeRow, direction, st, now, maxAttempts)) {
            record(direction, 'stalled', view);
            return 'stalled';
          }
          action = 'page' + st.attempts + (st.reenter ? 'away' : '');
          if (st.attempts >= 2) {
            note = 'Discord is slow to load ' + (direction < 0 ? 'older' : 'newer') + ' messages. Trying again (' + st.attempts + ' of ' + maxAttempts + ')…';
          }
        } else {
          sc.scrollTop += direction * Math.max(1, Math.floor(sc.clientHeight * 0.72));
          action = 'step';
        }
        record(direction, action, view);
        progress(phase, note);
        await sleep(STEP_MS);
      }
      return 'too-long';
    }

    // Phase 0: start from the newest messages. If Discord shows the
    // "Jump to Present" bar, click it and wait for the rebuilt list.
    var bar = jumpBar();
    var button = bar ? jumpButton(bar) : null;
    if (button) {
      button.click();
      record(1, 'jump', readView());
      progress('present', 'Jumping to the newest messages…');
      var jumpStart = Date.now();
      while (Date.now() - jumpStart < 20000) {
        checkAbort();
        await sleep(300);
        var after = readView();
        if (after.rows.length && after.scroller && !jumpBar()) break;
      }
    }

    // Skip the newest messages entirely when the book starts further back:
    // jump there with Discord's search instead of scrolling down through them.
    var down = 'skipped';
    if (untilMs !== null) {
      var chat = getChatInfo();
      var landed = await seekToDate(chat && chat.kind === 'channel' ? chat.channelId : null, untilMs, signal, function (note) {
        progress('seeking', note);
      });
      down = landed ? 'sought' : 'seek-failed';
      if (!landed) {
        progress('seeking', 'Discord would not jump there, so reading from the newest message instead.');
        down = await collect(1);
      }
    } else {
      down = await collect(1);
    }
    var up = down === 'list-missing' ? down : await collect(-1);

    var messages = Array.from(collected.values());
    messages.sort(function (a, b) {
      return (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    resolveAuthors(messages);
    if (fromMs !== null) {
      messages = messages.filter(function (m) { return snowflakeToMs(m.id) >= fromMs; });
    }
    if (untilMs !== null) {
      messages = messages.filter(function (m) { return snowflakeToMs(m.id) < untilMs + 86400000; });
    }
    if (messages.length > maxMessages) {
      messages = messages.slice(messages.length - maxMessages);
    }

    onProgress({
      collected: messages.length,
      oldestTs: messages.length > 0 ? messages[0].ts : null,
      phase: 'finishing',
      note: ''
    });

    return {
      messages: messages,
      // Skipping newer messages means the book is not the whole chat.
      complete: up === 'beginning' && untilMs === null,
      participants: computeParticipants(messages),
      diagnostics: {
        stopReason: up,
        present: down,
        seconds: Math.round((Date.now() - started) / 1000),
        trail: trail
      }
    };
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
