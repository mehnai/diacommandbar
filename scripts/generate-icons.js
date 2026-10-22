import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const svg = await readFile(new URL('../icons/mark.svg', import.meta.url), 'utf8');
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
    await page.screenshot({ path: new URL(`../icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
  }
} finally { await browser.close(); }
