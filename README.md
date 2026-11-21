# Discord Book

A Chrome extension that turns a Discord DM, group DM, or server channel into a typeset, book-style PDF:
a cover page, an "About this book" page, a table of contents, one chapter per month, day headings, drop caps,
running headers, page numbers, and PDF bookmarks. Classic (cream paper) and Midnight (dark) styles.

It reads only what Discord web already shows you. It scrolls the open chat and copies messages from the page.
It never calls Discord's API, reads your token, or touches Discord's internal code, so nothing is sent anywhere.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Pin **Discord Book** from the puzzle-piece menu.

## Use

1. Open a chat at discord.com in Chrome.
2. Click the extension, choose **Whole chat** or **Two people only**, and click **Create book**.
3. Keep the Discord tab open and in front while a small panel shows how many messages it has read.
   When it reaches the start of the chat, a new tab lays out the book and saves the PDF to
   `Downloads/Discord Books/<chat name> [id].pdf`.

**Exporting again replaces the old one.** Every export is saved in the extension (popup → *Saved books*) with its date
and an edition number. Making a book from the same chat again (or the same two people in the same channel) replaces the
saved record and overwrites the same PDF file, and the old entry is removed from Chrome's download list.

**Two people only** works in server channels and group DMs. Type two names as they appear in the chat (server
nicknames; the boxes suggest names visible on screen) or user IDs. The book keeps only those two people's messages,
in order, and their replies to each other keep their "replying to" lines.

**Options:** *Start from date* stops scrolling at that date, which helps in huge channels. You can also turn images off
and pick a style. *Open* in the saved-books list re-renders a saved book, with buttons to save the PDF again or print it.

## Limits

- Discord loads older messages about 50 at a time, so very long chats take a while (roughly a minute per few thousand
  messages). Keep the tab in front, because Chrome slows down background tabs.
- Names are the display names Discord shows (server nicknames in servers), since usernames are not on the page.
- Images are embedded from Discord's CDN at the time you make the book. Signed attachment links expire after a
  while, so re-opening an old saved book later may show image placeholders. Make a new export to refresh them.
- Discord changes its page markup from time to time. The scraper relies on Discord's long-stable element ids
  (`chat-messages-*`, `message-content-*`, and so on) and loose class-name matching, but a redesign may need an update.
- Chrome shows a short "Discord Book started debugging this browser" bar while saving. That is how the extension asks
  Chrome for a real print-quality PDF of its own book tab. If saving fails, the book tab offers **Print → Save as PDF**.

## Development

No build step. `npm install` installs the test tools, then:

- `node test/scraper.test.mjs` runs the scraper against `test/fixtures/discord-mock.html`, a virtualized imitation of
  Discord's DOM, and checks that every message is collected exactly once with the right author.
- `node test/render.test.mjs` renders `test/fixtures/sample-export.json` to PDFs and PNG pages in `test/out/`.
- `node test/e2e.test.mjs` loads the real extension in Chrome, serves the mock at a discord.com URL, and checks
  export, the automatic PDF download, replacement on re-export, two-person mode, and the popup.

Layout: `src/content/` (scraper and progress panel), `src/background.js` (storage and tabs), `src/book/` (renderer,
fonts, PDF saving), `src/popup/`, `src/lib/` (IndexedDB and naming). The data format is in `SPEC.md`.
Fonts are EB Garamond and Cormorant Garamond under the SIL Open Font License (see `src/book/fonts/`).
