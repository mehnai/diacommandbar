import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let context, worker, extensionId;

test.beforeEach(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--enable-unsafe-extension-debugging'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  await context.route('http://127.0.0.1:4173/fixture*', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Test source document</title></head><body style="background:#d9e5ed;padding:100px;font:24px system-ui"><h1>A page to come back to</h1><input id="original" aria-label="Original field" value="Keep this text"><p>Your original page stays right here.</p></body></html>' }));
});

test.afterEach(async () => { await context?.close(); });

async function commandPage() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('#status')).not.toContainText('Open the command bar using');
  return page;
}

async function trigger(page) {
  await page.bringToFront();
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targetInfos.find(info => info.url === page.url()) || targetInfos.find(info => info.embedderData?.tabActive && info.url === 'chrome://newtab/' && page.url() === `chrome-extension://${extensionId}/newtab.html`);
  if (!target) throw new Error(`No tab target for ${page.url()}: ${JSON.stringify(targetInfos)}`);
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  await browserSession.detach();
}

async function grantAutocompleteHost(page) {
  // Headless Chromium cannot interact with the native permission dialog.
  // Grant the optional host only in this disposable test profile; request,
  // contains, and remove still run through Chrome's real permission APIs.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(id => chrome.developerPrivate.addHostPermission(id, 'https://suggestqueries.google.com/*'), extensionId);
  await manager.close();
  await page.bringToFront();
}

async function enableNewTabOverlay(page) {
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(async id => {
    await chrome.developerPrivate.addHostPermission(id, 'http://*/*');
    await chrome.developerPrivate.addHostPermission(id, 'https://*/*');
  }, extensionId);
  await manager.close();
  await page.bringToFront();
  await page.locator('.page-settings').click();
  await page.getByRole('switch', { name: 'New tabs as overlay', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('New-tab overlay enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
}

test('optional new-tab overlay returns to the previous website without leaving an extra tab', async () => {
  const settings = await commandPage();
  await enableNewTabOverlay(settings);
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4173/fixture');
  await source.bringToFront();
  await source.getByRole('textbox', { name: 'Original field' }).fill('My unsaved text');
  const count = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  const placeholderId = await worker.evaluate(async () => (await chrome.tabs.create({})).id);
  await expect.poll(() => source.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  const frame = source.frames().find(f => f.url().includes('mode=overlay'));
  await expect(frame.getByRole('combobox')).toBeVisible();
  await expect.poll(() => worker.evaluate(async id => (await chrome.tabs.query({})).some(t => t.id === id), placeholderId)).toBe(false);
  expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(count);
  await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url)).toBe(source.url());
  await expect(frame.getByRole('combobox')).toBeFocused();
  await source.screenshot({ path: 'test-results/new-tab-overlay.png' });
  await frame.getByRole('combobox').press('Escape');
  await expect(source.getByRole('textbox', { name: 'Original field' })).toHaveValue('My unsaved text');
  await expect(source.getByRole('textbox', { name: 'Original field' })).toBeFocused();
  // Reloading an old command page, or opening an explicit command URL, keeps it.
  await settings.bringToFront();
  await settings.reload();
  await expect(settings.getByRole('combobox')).toBeEnabled();
  expect(settings.isClosed()).toBe(false);
  await settings.locator('.page-settings').click();
  await settings.getByRole('switch', { name: 'New tabs as overlay', exact: true }).uncheck();
  await expect(settings.locator('#settings-status')).toContainText('New-tab overlay is off');
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))).toBe(false);
});

test('new-tab mode keeps a usable command page when the previous page is restricted', async () => {
  const settings = await commandPage();
  await enableNewTabOverlay(settings);
  const source = await context.newPage();
  await source.goto('chrome://version/');
  await source.bringToFront();
  const nextPage = context.waitForEvent('page');
  const placeholderId = await worker.evaluate(async () => (await chrome.tabs.create({})).id);
  const page = await nextPage;
  await expect(page.getByRole('combobox')).toBeEnabled();
  expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, placeholderId)).toBe(true);
  expect(source.isClosed()).toBe(false);
});

test('new-tab overlay requires both its option and website permission', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ settings: { newTabOverlay: true } }));
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4173/fixture');
  await source.bringToFront();
  const nextPage = context.waitForEvent('page');
  const placeholderId = await worker.evaluate(async () => (await chrome.tabs.create({})).id);
  const page = await nextPage;
  await expect(page.getByRole('combobox')).toBeEnabled();
  expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).active, placeholderId)).toBe(true);
  await expect(source.locator('[data-dia-command-bar]')).toHaveCount(0);
});

test('new-tab website access keeps autocomplete opt-in and explains when Google access needs renewal', async () => {
  const requests = [];
  await context.route('https://suggestqueries.google.com/complete/search**', route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    requests.push(query);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([query, [`${query} ideas`]]) });
  });
  const page = await commandPage();
  await enableNewTabOverlay(page);
  await page.getByRole('combobox').fill('garden');
  await page.waitForTimeout(400);
  expect(requests).toEqual([]);
  await page.locator('.page-settings').click();
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'garden ideas' })).toBeVisible();
  await page.locator('.page-settings').click();
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).uncheck();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete is off');
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))).toBe(true);
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('switch', { name: 'New tabs as overlay', exact: true }).uncheck();
  await expect(page.locator('#settings-status')).toContainText('New-tab overlay is off');
  await expect(page.locator('#settings-status')).toContainText('Enable Query autocomplete again');
  await expect(page.getByRole('switch', { name: 'Query autocomplete', exact: true })).not.toBeChecked();
  await grantAutocompleteHost(page);
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('combobox').fill('weather');
  await expect(page.getByRole('option').filter({ hasText: 'weather ideas' })).toBeVisible();
});

test('real new-tab override loads browser tabs and switches to a selected tab', async () => {
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4173/fixture');
  const page = await context.newPage();
  await page.goto('chrome://newtab/');
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('combobox').fill('@ Test source');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('combobox').press('Enter');
  await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.title)).toBe('Test source document');
  expect(context.pages()).toContain(page);
});

test('URLs navigate and web searches use the selected provider', async () => {
  const page = await commandPage();
  await page.getByRole('combobox').fill('http://127.0.0.1:4173/fixture?from=bar');
  await page.getByRole('combobox').press('Enter');
  await expect(page).toHaveURL('http://127.0.0.1:4173/fixture?from=bar');
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.locator('.page-settings').click();
  await page.getByLabel('Search engine', { exact: true }).selectOption('duckduckgo');
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.route('https://duckduckgo.com/**', route => route.fulfill({ body: 'Search destination reached.' }));
  await page.getByRole('combobox').fill('a calmer browser');
  await expect(page.getByRole('option').first()).toContainText('DuckDuckGo');
  await page.getByRole('combobox').press('Enter');
  await expect(page).toHaveURL('https://duckduckgo.com/?q=a%20calmer%20browser');
});

test('toolbar opens an authorized overlay, Escape restores focus, and navigation preserves the page', async () => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixture');
  await page.getByRole('textbox', { name: 'Original field' }).focus();
  const backgroundClip = { x: 0, y: 0, width: 80, height: 80 };
  const background = await page.screenshot({ clip: backgroundClip });
  await trigger(page);
  await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  let frame = page.frames().find(f => f.url().includes('mode=overlay'));
  await expect(frame.getByRole('combobox')).toBeVisible();
  await expect(frame.getByRole('option').first()).toContainText('Test source');
  await expect(frame.locator('#status')).toBeEmpty();
  expect(await page.screenshot({ clip: backgroundClip })).toEqual(background);
  await page.screenshot({ path: 'test-results/extension-overlay.png', animations: 'disabled' });
  await frame.locator('.footer-settings').click();
  await frame.getByLabel('Appearance').selectOption('dark');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.locator('html')).toHaveCSS('color-scheme', 'normal');
  expect(await page.screenshot({ clip: backgroundClip })).toEqual(background);
  await page.screenshot({ path: 'test-results/extension-overlay-dark.png', animations: 'disabled' });
  await frame.getByRole('combobox').press('Shift+Tab');
  await expect(frame.getByRole('button', { name: 'Move command bar', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Move command bar', exact: true }).press('Shift+Tab');
  await expect(frame.locator('.footer-settings')).toBeFocused();
  await frame.locator('.footer-settings').press('Tab');
  await expect(frame.getByRole('button', { name: 'Move command bar', exact: true })).toBeFocused();
  await frame.getByRole('button', { name: 'Move command bar', exact: true }).press('Tab');
  await expect(frame.getByRole('combobox')).toBeFocused();
  await frame.getByRole('combobox').press('Escape');
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Original field' })).toBeFocused();
  await trigger(page);
  await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  frame = page.frames().find(f => f.url().includes('mode=overlay'));
  // Browser-created tabs can begin navigation before Playwright routing attaches.
  // Use a real server resource for the destination's first request.
  await frame.getByRole('combobox').fill('http://127.0.0.1:4173/newtab.html?destination');
  const newPagePromise = context.waitForEvent('page');
  await frame.getByRole('combobox').press('Enter');
  const destination = await newPagePromise;
  await expect(destination).toHaveURL('http://127.0.0.1:4173/newtab.html?destination');
  await expect(page).toHaveURL('http://127.0.0.1:4173/fixture');
  await expect(page.getByRole('textbox', { name: 'Original field' })).toHaveValue('Keep this text');
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
});

test('overlay grip drags without stealing input, stays onscreen, and supports keyboard movement and reset', async () => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixture');
  await trigger(page);
  await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  const frame = page.frames().find(f => f.url().includes('mode=overlay'));
  const handle = frame.getByRole('button', { name: 'Move command bar', exact: true });
  const input = frame.getByRole('combobox');
  const stage = frame.locator('.stage');
  await input.fill('keep this query');
  await handle.hover();
  const start = await stage.boundingBox();
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  const moved = await stage.boundingBox();
  expect(moved.x - start.x).toBeCloseTo(120, 0);
  expect(moved.y - start.y).toBeCloseTo(80, 0);
  await expect(input).toHaveValue('keep this query');
  await expect(input).toBeFocused();
  await handle.focus();
  await handle.press('ArrowLeft');
  expect((await stage.boundingBox()).x).toBeCloseTo(moved.x - 10, 0);
  await handle.press('Home');
  expect((await stage.boundingBox()).x).toBeCloseTo(start.x, 0);
  expect((await stage.boundingBox()).y).toBeCloseTo(start.y, 0);
  // Pointer capture keeps the drag alive when the pointer leaves the grip.
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(1438, 998, { steps: 5 });
  await page.mouse.up();
  const edge = await stage.boundingBox();
  expect(edge.x + edge.width).toBeLessThanOrEqual(1432);
  expect(edge.y + edge.height).toBeLessThanOrEqual(992);
  await page.setViewportSize({ width: 640, height: 420 });
  await expect.poll(async () => {
    const rect = await stage.boundingBox();
    return rect.x >= 8 && rect.y >= 8 && rect.x + rect.width <= 632 && rect.y + rect.height <= 412;
  }).toBe(true);
  await handle.dblclick();
  const centered = await stage.boundingBox();
  expect(centered.x + centered.width / 2).toBeCloseTo(320, 0);
  await page.screenshot({ path: 'test-results/overlay-drag-small.png' });
  await frame.locator('.footer-settings').click();
  await expect(frame.getByRole('dialog', { name: 'Your command bar' })).toBeVisible();
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await input.press('Escape');
  await input.press('Escape');
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
});

test('only the bar can paint over a dark website, even when the iframe canvas is opaque', async () => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixture');
  await page.evaluate(() => {
    document.documentElement.style.colorScheme = 'dark';
    document.body.style.background = '#192431';
    document.body.style.color = '#eee';
  });
  const clip = { x: 0, y: 0, width: 80, height: 80 };
  const background = await page.screenshot({ clip });
  await trigger(page);
  await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  const frame = page.frames().find(f => f.url().includes('mode=overlay'));
  await expect(frame.getByRole('combobox')).toBeVisible();
  await expect(frame.getByRole('option').first()).toContainText('Test source');
  await frame.getByRole('combobox').click();
  await page.screenshot({ path: 'test-results/overlay-dark-website.png', animations: 'disabled' });
  expect(await page.screenshot({ clip })).toEqual(background);
  await frame.locator('.footer-settings').click();
  await frame.getByLabel('Appearance').selectOption('dark');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  expect(await page.screenshot({ clip })).toEqual(background);
  // Reproduce an opaque iframe canvas independently of browser compositing.
  await frame.evaluate(() => {
    document.documentElement.style.setProperty('background', '#b729be', 'important');
    document.body.style.setProperty('background', '#b729be', 'important');
  });
  expect(await page.screenshot({ clip })).toEqual(background);
  await frame.getByRole('combobox').fill('the page stays visible');
  await page.screenshot({ path: 'test-results/overlay-opaque-canvas-contained.png', animations: 'disabled' });
  await frame.locator('.footer-settings').click();
  await expect(frame.getByRole('dialog', { name: 'Your command bar' })).toBeVisible();
  expect(await page.screenshot({ clip })).toEqual(background);
  // Outside clicks first close settings, then dismiss the command bar.
  await page.mouse.click(40, 40);
  await expect(frame.getByRole('dialog', { name: 'Your command bar' })).not.toBeVisible();
  await expect(frame.getByRole('combobox')).toHaveValue('the page stays visible');
  await page.mouse.click(40, 40);
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
});

test('restricted browser pages open a full command tab', async () => {
  const page = await context.newPage();
  await page.goto('chrome://version/');
  const newPagePromise = context.waitForEvent('page');
  await trigger(page);
  const destination = await newPagePromise;
  await expect(destination.getByRole('combobox')).toBeVisible();
  await expect(destination).toHaveURL(new RegExp(`${extensionId}/newtab.html\\?source=shortcut`));
});

test('invoking the extension on its own command pages focuses the existing input without extra tabs', async () => {
  const errors = [];
  context.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const sibling = await context.newPage();
  await sibling.goto(`chrome-extension://${extensionId}/newtab.html?sibling=1`);
  await sibling.locator('.page-settings').click();
  for (const url of [
    `chrome-extension://${extensionId}/newtab.html?source=shortcut`,
    `chrome-extension://${extensionId}/newtab.html`,
    'chrome://newtab/',
  ]) {
    const page = await context.newPage();
    await page.goto(url);
    const input = page.getByRole('combobox');
    await expect(input).toBeEnabled();
    await input.fill('keep my search');
    await page.locator('.page-settings').click();
    const count = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    await trigger(page);
    await expect(page.getByRole('dialog', { name: 'Your command bar' })).not.toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('keep my search');
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(count);
    await expect(sibling.getByRole('dialog', { name: 'Your command bar' })).toBeVisible();
    await page.close();
  }
  expect(errors).toEqual([]);
});

test('forged embedded pages cannot retrieve browser data or execute actions', async () => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixture');
  await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, `chrome-extension://${extensionId}/newtab.html?mode=overlay&token=forged`);
  await expect.poll(() => page.frames().find(f => f.url().includes('token=forged'))?.url()).toBeTruthy();
  const frame = page.frames().find(f => f.url().includes('token=forged'));
  const response = await frame.evaluate(() => chrome.runtime.sendMessage({ type: 'snapshot' }));
  expect(response.ok).toBe(false);
  expect(response.data).toBeUndefined();
  const action = await frame.evaluate(() => chrome.runtime.sendMessage({ type: 'execute', item: { kind: 'command', id: 'new-window' } }));
  expect(action.ok).toBe(false);
  const autocomplete = await frame.evaluate(() => chrome.runtime.sendMessage({ type: 'autocomplete', input: 'weather' }));
  expect(autocomplete.ok).toBe(false);
});

test('query autocomplete is opt-in, completes searches, and revokes its host access when disabled', async () => {
  const requests = [];
  await context.route('https://suggestqueries.google.com/complete/search**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    requests.push(query);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([query, [`${query} tomorrow`, `${query} this week`]]) });
  });
  const page = await commandPage();
  const input = page.getByRole('combobox');
  await input.fill('weather');
  await page.waitForTimeout(450);
  expect(requests).toEqual([]);
  await page.locator('.page-settings').click();
  await expect(page.getByRole('switch', { name: 'Query autocomplete', exact: true })).not.toBeChecked();
  await grantAutocompleteHost(page);
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByLabel('Search engine', { exact: true }).selectOption('bing');
  await page.screenshot({ path: 'test-results/autocomplete-settings.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'weather tomorrow' })).toBeVisible();
  expect(requests).toEqual(['weather']);
  await expect(page.getByRole('option').filter({ hasText: 'weather tomorrow' })).toContainText('Search Bing');
  await page.screenshot({ path: 'test-results/autocomplete-results.png', animations: 'disabled' });
  await context.route('https://www.bing.com/search**', route => route.fulfill({ body: 'Search completed.' }));
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL('https://www.bing.com/search?q=weather%20tomorrow');
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.locator('.page-settings').click();
  await expect(page.getByRole('switch', { name: 'Query autocomplete', exact: true })).toBeChecked();
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).uncheck();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete is off');
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://suggestqueries.google.com/*'] }))).toBe(false);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await input.fill('another query');
  await page.waitForTimeout(450);
  expect(requests).toEqual(['weather']);
});

test('autocomplete discards old queries, stays local in source filters, and handles provider failure', async () => {
  const requests = [];
  let releaseFirst;
  const pendingFirst = new Promise(resolve => { releaseFirst = resolve; });
  await context.route('https://suggestqueries.google.com/complete/search**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    requests.push(query);
    if (query === 'weather') await pendingFirst;
    if (query === 'offline query') { await route.abort(); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([query, [`${query} ideas`]]) }).catch(() => {});
  });
  const page = await commandPage();
  await grantAutocompleteHost(page);
  await page.locator('.page-settings').click();
  await page.getByRole('switch', { name: 'Query autocomplete', exact: true }).check();
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
  const input = page.getByRole('combobox');
  await input.fill('weather');
  await expect.poll(() => requests).toEqual(['weather']);
  await input.fill('garden');
  await expect(page.getByRole('option').filter({ hasText: 'garden ideas' })).toBeVisible();
  releaseFirst();
  await expect(page.getByRole('option').filter({ hasText: 'weather ideas' })).toHaveCount(0);
  await input.fill('@garden');
  await page.waitForTimeout(400);
  await input.fill('localhost:3000');
  await page.waitForTimeout(400);
  expect(requests).toEqual(['weather', 'garden']);
  await input.fill('offline query');
  await expect(page.locator('#autocomplete-status')).toContainText('You can still search');
  await expect(page.getByRole('option').first()).toContainText('Search your default search engine');
});

test('an existing enabled preference cannot send queries to Google without its new host permission', async () => {
  let requests = 0;
  await context.route('https://suggestqueries.google.com/complete/search**', route => {
    requests++;
    return route.fulfill({ contentType: 'application/json', body: '["weather",["weather tomorrow"]]' });
  });
  // Simulate settings retained from the previous suggestion provider.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { autocomplete: true } }));
  const page = await commandPage();
  await page.getByRole('combobox').fill('weather');
  await page.waitForTimeout(400);
  const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'autocomplete', input: 'weather', filter: 'all' }));
  expect(response.data.suggestions).toEqual([]);
  expect(requests).toBe(0);
  await page.locator('.page-settings').click();
  await expect(page.getByRole('switch', { name: 'Query autocomplete', exact: true })).not.toBeChecked();
});
