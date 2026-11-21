/**
 * Scraper tests — runs the DOM scraper against the mock Discord page.
 * Usage: node test/scraper.test.mjs
 */

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const MOCK_HTML_PATH = resolve(__dirname, 'fixtures', 'discord-mock.html');
const SCRAPER_PATH = resolve(PROJECT_ROOT, 'src', 'content', 'scraper.js');

const CHROME_PATH = '/usr/local/bin/google-chrome';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error('  FAIL: ' + label);
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    var msg = label + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual);
    failures.push(msg);
    console.error('  FAIL: ' + msg);
  }
}

async function runTests() {
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    protocolTimeout: 180000
  });

  try {
    await testDmExact(browser);
    await testChannelExact(browser);
    await testScrolledUpPartway(browser);
    await testNonFastTiming(browser);
    await testDoubleScrape(browser);
    await testManualScrollToTop(browser);
    await testFromDate(browser);
    await testMaxMessages(browser);
    await testAbort(browser);
    await testSanitization(browser);
    await testChatInfo(browser);
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  } else {
    console.log('All tests passed!');
    process.exit(0);
  }
}

async function openMockPage(browser, kind, fast) {
  var page = await browser.newPage();
  var params = fast !== false ? 'fast' : '';
  if (kind) params += (params ? '&' : '') + 'kind=' + kind;
  var fileUrl = 'file://' + MOCK_HTML_PATH + (params ? '?' + params : '');
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    return window.__mockTruth && window.__mockTruth.length > 0;
  }, { timeout: 15000 });
  await page.addScriptTag({ path: SCRAPER_PATH });
  await page.waitForFunction(function () {
    return window.DiscordBookScraper &&
           typeof window.DiscordBookScraper.scrape === 'function';
  }, { timeout: 5000 });
  return page;
}

function checkExactMatch(result, truth, label) {
  var collectedIds = new Set(result.messages.map(function (m) { return m.id; }));
  var truthIds = new Set(truth.map(function (t) { return t.id; }));

  var missing = truth.filter(function (t) { return !collectedIds.has(t.id); });
  var extra = result.messages.filter(function (m) { return !truthIds.has(m.id); });
  missing.slice(0, 5).forEach(function (t) { console.log('    missing ' + label + ': ' + JSON.stringify(t).slice(0, 200)); });

  assertEq(missing.length, 0, label + ': no truth messages missing (got ' + missing.length + ')');
  assertEq(extra.length, 0, label + ': no extra messages beyond truth (got ' + extra.length + ')');
  assertEq(result.messages.length, truth.length, label + ': exact message count');

  // Verify chronological order
  var ordered = true;
  for (var i = 1; i < result.messages.length; i++) {
    if (result.messages[i].id < result.messages[i - 1].id) {
      ordered = false;
      break;
    }
  }
  assert(ordered, label + ': messages in chronological order');

  // Verify no duplicate IDs
  var idCounts = {};
  result.messages.forEach(function (m) { idCounts[m.id] = (idCounts[m.id] || 0) + 1; });
  var dupCount = Object.values(idCounts).filter(function (c) { return c > 1; }).length;
  assertEq(dupCount, 0, label + ': no duplicate messages');

  // Verify author names match truth for non-system messages
  var truthById = {};
  truth.forEach(function (t) { truthById[t.id] = t; });
  var authorMismatches = 0;
  result.messages.forEach(function (m) {
    var t = truthById[m.id];
    if (!t || t.system || m.system) return;
    if (!m.author || !m.author.name) {
      authorMismatches++;
    } else if (m.author.name !== t.authorName) {
      authorMismatches++;
    }
  });
  assertEq(authorMismatches, 0, label + ': author names match truth (' + authorMismatches + ' mismatches)');

  return { missing: missing, extra: extra };
}

// -----------------------------------------------------------------------
// Test: DM mode — exact collection
// -----------------------------------------------------------------------
async function testDmExact(browser) {
  console.log('\n--- Test: DM mode exact collection ---');
  var page = await openMockPage(browser, 'dm', true);

  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete, participants: res.participants };
  });
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  assert(result.complete === true, 'DM: complete === true');
  checkExactMatch(result, truth, 'DM');

  // Participants
  assert(result.participants.length > 0, 'DM: has participants');
  assert(result.participants.length <= 3, 'DM: at most 3 participants');

  // Message-type coverage
  var msgs = result.messages;
  assert(msgs.filter(function (m) { return m.edited; }).length > 0, 'DM: has edited messages');
  assert(msgs.filter(function (m) { return m.reply; }).length > 0, 'DM: has reply messages');
  assert(msgs.filter(function (m) { return m.attachments && m.attachments.length > 0; }).length > 0, 'DM: has attachment messages');
  assert(msgs.filter(function (m) { return m.embeds && m.embeds.length > 0; }).length > 0, 'DM: has embed messages');
  assert(msgs.filter(function (m) { return m.stickers && m.stickers.length > 0; }).length > 0, 'DM: has sticker messages');
  assert(msgs.filter(function (m) { return m.reactions && m.reactions.length > 0; }).length > 0, 'DM: has reaction messages');
  assert(msgs.filter(function (m) { return m.system; }).length > 0, 'DM: has system messages');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: Channel mode — exact collection
// -----------------------------------------------------------------------
async function testChannelExact(browser) {
  console.log('\n--- Test: Channel mode exact collection ---');
  var page = await openMockPage(browser, 'channel', true);

  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  assert(result.complete === true, 'Channel: complete === true');
  checkExactMatch(result, truth, 'Channel');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: Scrolled up partway before scrape starts
// -----------------------------------------------------------------------
async function testScrolledUpPartway(browser) {
  console.log('\n--- Test: Scrolled up partway ---');
  var page = await browser.newPage();
  var fileUrl = 'file://' + MOCK_HTML_PATH + '?fast&kind=dm';
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    return window.__mockTruth && window.__mockTruth.length > 0;
  }, { timeout: 15000 });

  // Pre-scroll: scroll up several times to load older messages,
  // then position the viewport in the middle.
  await page.evaluate(async function () {
    var scroller = document.querySelector('.scroller_ef3116');
    for (var i = 0; i < 5; i++) {
      scroller.scrollTop = 0;
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    // Now scroll to roughly the middle
    scroller.scrollTop = scroller.scrollHeight / 3;
    await new Promise(function (r) { setTimeout(r, 400); });
  });

  // Now inject the scraper and run
  await page.addScriptTag({ path: SCRAPER_PATH });
  await page.waitForFunction(function () {
    return window.DiscordBookScraper &&
           typeof window.DiscordBookScraper.scrape === 'function';
  }, { timeout: 5000 });

  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  assert(result.complete === true, 'Partway: complete === true');
  checkExactMatch(result, truth, 'Partway');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: Non-fast (default) timing
// -----------------------------------------------------------------------
async function testNonFastTiming(browser) {
  console.log('\n--- Test: Non-fast timing ---');
  var page = await openMockPage(browser, 'dm', false);

  var t0 = Date.now();
  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });
  var elapsed = Date.now() - t0;
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  console.log('  (non-fast scrape took ' + elapsed + 'ms)');
  assert(result.complete === true, 'Non-fast: complete === true');
  checkExactMatch(result, truth, 'Non-fast');

  // Non-fast should take noticeably longer due to 300-1200ms load delays
  assert(elapsed > 3000, 'Non-fast: took more than 3s (actual ' + elapsed + 'ms)');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: Double scrape (same page, twice in a row)
// -----------------------------------------------------------------------
async function testDoubleScrape(browser) {
  console.log('\n--- Test: Double scrape ---');
  var page = await openMockPage(browser, 'dm', true);

  // First scrape — scrolls to top, loads everything
  var r1 = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  assert(r1.complete === true, 'Double-1: first scrape complete');
  checkExactMatch(r1, truth, 'Double-1');

  // Second scrape — must also get all messages even though the DOM
  // is now at the oldest messages and newest are trimmed
  var r2 = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });

  assert(r2.complete === true, 'Double-2: second scrape complete');
  checkExactMatch(r2, truth, 'Double-2');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: Manual scroll to top, then scrape
// -----------------------------------------------------------------------
async function testManualScrollToTop(browser) {
  console.log('\n--- Test: Manual scroll to top, then scrape ---');
  var page = await browser.newPage();
  var fileUrl = 'file://' + MOCK_HTML_PATH + '?fast&kind=dm';
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    return window.__mockTruth && window.__mockTruth.length > 0;
  }, { timeout: 15000 });

  // Manually scroll all the way to the top (oldest messages)
  // Keep scrolling until the beginning marker appears
  await page.evaluate(async function () {
    var scroller = document.querySelector('.scroller_ef3116');
    for (var i = 0; i < 30; i++) {
      scroller.scrollTop = 0;
      await new Promise(function (r) { setTimeout(r, 400); });
      // Check if beginning marker is visible
      if (document.querySelector('[class*="emptyChannel"]')) break;
    }
  });

  // Now inject the scraper and run
  await page.addScriptTag({ path: SCRAPER_PATH });
  await page.waitForFunction(function () {
    return window.DiscordBookScraper &&
           typeof window.DiscordBookScraper.scrape === 'function';
  }, { timeout: 5000 });

  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({});
    return { messages: res.messages, complete: res.complete };
  });
  var truth = await page.evaluate(function () { return window.__mockTruth; });

  assert(result.complete === true, 'ManualTop: complete === true');
  checkExactMatch(result, truth, 'ManualTop');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: fromDate filter
// -----------------------------------------------------------------------
async function testFromDate(browser) {
  console.log('\n--- Test: fromDate filter ---');
  var page = await openMockPage(browser, 'dm', true);

  var result = await page.evaluate(async function () {
    var full = await window.DiscordBookScraper.scrape({});
    var msgs = full.messages;
    if (msgs.length < 30) return { ok: false, reason: 'too few messages' };

    var idx = Math.floor(msgs.length * 0.3);
    var cutoffDate = new Date(msgs[idx].ts);

    var filtered = await window.DiscordBookScraper.scrape({ fromDate: cutoffDate });

    return {
      fullCount: msgs.length,
      filteredCount: filtered.messages.length,
      cutoff: cutoffDate.toISOString(),
      allAfterCutoff: filtered.messages.every(function (m) { return new Date(m.ts) >= cutoffDate; })
    };
  });

  assert(result.ok !== false, 'fromDate: enough messages');
  if (result.ok !== false) {
    assert(result.filteredCount < result.fullCount, 'fromDate: filtered fewer than full');
    assert(result.allAfterCutoff, 'fromDate: all filtered messages after cutoff');
  }

  await page.close();
}

// -----------------------------------------------------------------------
// Test: maxMessages limit
// -----------------------------------------------------------------------
async function testMaxMessages(browser) {
  console.log('\n--- Test: maxMessages limit ---');
  var page = await openMockPage(browser, 'dm', true);

  var result = await page.evaluate(async function () {
    var limited = await window.DiscordBookScraper.scrape({ maxMessages: 30 });
    var full = await window.DiscordBookScraper.scrape({});

    var newestFromFull = full.messages.slice(-30).map(function (m) { return m.id; });
    var limitedIds = limited.messages.map(function (m) { return m.id; });
    var allMatch = limitedIds.every(function (id) { return newestFromFull.indexOf(id) !== -1; });

    return {
      limitedCount: limited.messages.length,
      fullCount: full.messages.length,
      allMatch: allMatch
    };
  });

  assert(result.limitedCount <= 30, 'maxMessages: limited to at most 30');
  assert(result.limitedCount > 0, 'maxMessages: got some messages');
  assert(result.allMatch, 'maxMessages: limited messages are among newest');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: abort via AbortSignal
// -----------------------------------------------------------------------
async function testAbort(browser) {
  console.log('\n--- Test: abort via AbortSignal ---');
  var page = await openMockPage(browser, 'dm', false); // non-fast so it doesn't finish before abort

  var result = await page.evaluate(async function () {
    var controller = new AbortController();
    setTimeout(function () { controller.abort(); }, 300);

    try {
      await window.DiscordBookScraper.scrape({ signal: controller.signal });
      return { aborted: false };
    } catch (e) {
      return { aborted: true, name: e.name };
    }
  });

  assert(result.aborted === true, 'abort: scrape was aborted');
  assertEq(result.name, 'AbortError', 'abort: error is AbortError');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: HTML sanitization
// -----------------------------------------------------------------------
async function testSanitization(browser) {
  console.log('\n--- Test: HTML sanitization ---');
  var page = await openMockPage(browser, 'dm', true);

  var result = await page.evaluate(async function () {
    var res = await window.DiscordBookScraper.scrape({ maxMessages: 100 });
    var messages = res.messages;

    var issues = [];
    var disallowedTags = ['script', 'style', 'iframe', 'object', 'embed', 'form',
      'input', 'button', 'select', 'textarea', 'link', 'meta', 'head', 'body', 'html'];
    var disallowedAttrs = ['onclick', 'onload', 'onerror', 'onmouseover'];

    for (var i = 0; i < messages.length; i++) {
      var html = messages[i].html || '';
      if (!html) continue;

      for (var t = 0; t < disallowedTags.length; t++) {
        var tag = disallowedTags[t];
        var regex = new RegExp('<' + tag + '[\\s>]', 'i');
        if (regex.test(html)) {
          issues.push('msg ' + messages[i].id + ' contains <' + tag + '>');
        }
      }

      // Check for style= attribute anywhere
      if (/\sstyle\s*=/.test(html)) {
        issues.push('msg ' + messages[i].id + ' contains style=');
      }

      // Check for id= attribute
      if (/\sid\s*=/.test(html)) {
        issues.push('msg ' + messages[i].id + ' contains id=');
      }

      // Check for event handlers
      for (var a = 0; a < disallowedAttrs.length; a++) {
        if (html.indexOf(disallowedAttrs[a] + '=') !== -1) {
          issues.push('msg ' + messages[i].id + ' contains ' + disallowedAttrs[a] + '=');
        }
      }

      // Check for data- attributes
      if (/data-\w+=/.test(html)) {
        issues.push('msg ' + messages[i].id + ' contains data- attribute');
      }
    }

    return { issues: issues, sampleCount: messages.length };
  });

  if (result.issues.length > 0) {
    console.error('  Sanitization issues:');
    result.issues.forEach(function (iss) { console.error('    ' + iss); });
  }
  assertEq(result.issues.length, 0, 'sanitization: no disallowed tags/attrs');

  await page.close();
}

// -----------------------------------------------------------------------
// Test: getChatInfo and listVisibleAuthors
// -----------------------------------------------------------------------
async function testChatInfo(browser) {
  console.log('\n--- Test: getChatInfo and listVisibleAuthors ---');

  // DM mode
  var dmPage = await openMockPage(browser, 'dm', true);
  var dmInfo = await dmPage.evaluate(function () {
    return window.DiscordBookScraper.getChatInfo();
  });
  assert(dmInfo !== null, 'chatInfo DM: non-null');
  assertEq(dmInfo.guildId, '@me', 'chatInfo DM: guildId is @me');
  assert(dmInfo.kind === 'dm' || dmInfo.kind === 'group', 'chatInfo DM: kind is dm or group');
  assert(dmInfo.title.length > 0, 'chatInfo DM: has title');

  var dmAuthors = await dmPage.evaluate(function () {
    return window.DiscordBookScraper.listVisibleAuthors();
  });
  assert(dmAuthors.length > 0, 'listVisibleAuthors DM: found authors');
  assert(dmAuthors[0].name && dmAuthors[0].name.length > 0, 'listVisibleAuthors DM: authors have names');

  // Verify the false-positive sidebar trap didn't fool checkComplete
  var dmTrapCheck = await dmPage.evaluate(function () {
    // The sidebar outside the scroller contains "Welcome to #general" and
    // "This is the beginning of your" — if checkComplete were looking
    // at the whole document, it would have matched.  We already verified
    // the scrape collected all messages, but double-check the sidebar
    // text is actually present.
    var sidebar = document.querySelector('.sidebar_de23db');
    return sidebar ? sidebar.textContent.substring(0, 150) : null;
  });
  assert(dmTrapCheck && dmTrapCheck.indexOf('Welcome to #general') !== -1,
    'chatInfo DM: false-positive trap text present in sidebar');
  await dmPage.close();

  // Channel mode
  var chPage = await openMockPage(browser, 'channel', true);
  var chInfo = await chPage.evaluate(function () {
    return window.DiscordBookScraper.getChatInfo();
  });
  assert(chInfo !== null, 'chatInfo Channel: non-null');
  assertEq(chInfo.kind, 'channel', 'chatInfo Channel: kind is channel');
  assert(chInfo.guildId !== '@me', 'chatInfo Channel: guildId is not @me');
  await chPage.close();
}

runTests().catch(function (err) {
  console.error('Test runner error:', err);
  process.exit(1);
});
