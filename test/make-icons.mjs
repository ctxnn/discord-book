import puppeteer from 'puppeteer-core';
import { readFile } from 'node:fs/promises';
const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: '/usr/local/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: new URL(`../icons/icon${size}.png`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
