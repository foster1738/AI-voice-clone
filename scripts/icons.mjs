// Renders app/icons/icon.svg to the PNG sizes the manifest needs.
// Usage: node scripts/icons.mjs   (needs Playwright + Chromium)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright.mjs';

const { chromium } = await loadPlaywright();
const svg = readFileSync(fileURLToPath(new URL('../app/icons/icon.svg', import.meta.url)), 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:#0b0b14}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: fileURLToPath(new URL(`../app/icons/icon-${size}.png`, import.meta.url)) });
  console.log('icon', size);
}
await browser.close();
