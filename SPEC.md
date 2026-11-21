# Discord Book: spec shared by all agents

A Manifest V3 Chrome extension. In Discord web it scrolls through the open chat, reads the messages straight
from the page DOM (no Discord API, no tokens, no webpack/internal module access), and saves the
chat as a book-style PDF. Each chat has one saved export record, and exporting it again replaces both the
record and the PDF file.

Project root: /workspace/discord-book (plain JS, no bundler, no build step; chrome loads files as-is).

## Layout and ownership

| Path | Owner |
|---|---|
| manifest.json, src/background.js, src/popup/*, src/content/content.js, src/book/book.js, src/lib/* | orchestrator |
| src/content/scraper.js, test/fixtures/discord-mock.html, test/fixtures/discord-mock.js, test/scraper.test.mjs | scraper agent |
| src/book/book.html, src/book/book.css, src/book/book-render.js, src/book/fonts/*, test/fixtures/sample-export.json, test/render.test.mjs | renderer agent |

Never edit a file another agent owns. Never run git commands that commit (the orchestrator commits).

## ExportRecord (the one data contract)

```js
{
  key: "dm:<channelId>" | "ch:<guildId>:<channelId>" | "ch:<guildId>:<channelId>:pair:<a>|<b>", // a,b lowercased+sorted
  chat: {
    guildId: "@me" | "<snowflake>",
    channelId: "<snowflake>",
    kind: "dm" | "group" | "channel",
    title: "alice" | "#general",          // what the header shows
    serverName: null | "My Server",
    url: "https://discord.com/channels/..."
  },
  mode: "full" | "pair",
  pair: null | ["alice", "bob"],          // as typed by the user (pair mode only)
  createdAt: "ISO",                        // when this export was made
  version: 1,                              // number of times this chat has been exported (1, 2, 3, ...)
  complete: true,                          // true when the scrape reached the beginning of the chat
  participants: [ { name, id, avatar, count } ],   // sorted by count desc
  messages: [ Message ]                    // chronological (ascending snowflake)
}
```

```js
Message = {
  id: "<snowflake string>",
  ts: "ISO",                     // derived from the snowflake: Number(BigInt(id) >> 22n) + 1420070400000
  author: { name: "Alice", id: "<user snowflake>" | null, avatar: "https://cdn.discordapp.com/avatars/..." | null },
  html: "<sanitized html>",      // message body, whitelist below; "" when the message has no text
  text: "plain text",
  edited: false,
  reply: null | { author: "Bob", text: "snippet of the replied message" },
  attachments: [
    { type: "image", url, name, width, height },   // width/height may be null
    { type: "video", url, name, poster },
    { type: "file",  url, name, size }               // size is the display string, may be null
  ],
  embeds: [ { provider, author, title, description, url, image, color } ],   // any field may be null
  stickers: [ { name, url } ],
  reactions: [ { emoji: "👍" | null, emojiUrl: null | "https://cdn.discordapp.com/emojis/...", count: 3 } ],
  system: false                  // true for join/call/pin/etc. lines; html/text holds the line
}
```

Sanitized html whitelist: `strong em u s del code pre blockquote br p ul ol li h1 h2 h3 a(href) span(class="mention"|"spoiler"|"timestamp")
img(class="emoji", src, alt)`. Everything else is unwrapped to its children; scripts/styles/attributes stripped.
Custom emoji become `<img class="emoji" src="https://cdn.discordapp.com/emojis/..." alt=":name:">`; unicode
emoji images Discord renders as <img> become their alt text (the actual unicode character).
