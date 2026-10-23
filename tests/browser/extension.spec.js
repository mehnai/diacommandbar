import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let context, worker, extensionId;

async function section(ui, name) {
  await ui.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
}
async function choose(ui, tab, label, value) {
  await section(ui, tab);
  const button = ui.getByRole('group', { name: label, exact: true }).getByRole('button', { name: value, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toBeEnabled();
}
async function chosen(ui, tab, label, value) {
  await section(ui, tab);
  await expect(ui.getByRole('group', { name: label, exact: true }).getByRole('button', { name: value, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

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
  const target = targetInfos.find(info => info.url === page.url()) || targetInfos.find(info => info.embedderData?.tabActive && info.url === 'chrome://newtab/' && [`chrome-extension://${extensionId}/newtab.html`, 'chrome://new-tab-page/'].includes(page.url()));
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
  await page.locator('.footer-settings').click();
  await choose(page, 'Overlay', 'Open new tabs as an overlay', 'On');
  await expect(page.locator('#settings-status')).toContainText('New-tab overlay enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
}

// Source grants are a fixture because headless Chromium cannot accept native
// optional API-permission dialogs. Host grants and their removal remain real.
async function grantSourceFixtures(names) {
  await worker.evaluate(names => {
    const contains = chrome.permissions.contains.bind(chrome.permissions);
    const getAll = chrome.permissions.getAll.bind(chrome.permissions);
    const remove = chrome.permissions.remove.bind(chrome.permissions);
    const sourceNames = ['bookmarks', 'history'];
    const granted = globalThis.sourceGrants = new Set(names);
    globalThis.removedSourceGrants = [];
    chrome.permissions.contains = options => {
      if ((options.permissions || []).some(name => sourceNames.includes(name) && !granted.has(name))) return Promise.resolve(false);
      return contains({ ...options, permissions: (options.permissions || []).filter(name => !sourceNames.includes(name)) });
    };
    chrome.permissions.getAll = async () => {
      const actual = await getAll();
      return { ...actual, permissions: [...new Set([...actual.permissions, ...granted])] };
    };
    chrome.permissions.remove = async options => {
      for (const name of options.permissions || []) if (sourceNames.includes(name)) {
        granted.delete(name); globalThis.removedSourceGrants.push(name);
      }
      const permissions = (options.permissions || []).filter(name => !sourceNames.includes(name));
      return permissions.length || options.origins?.length ? remove({ ...options, permissions }) : true;
    };
    const bookmark = { id: 'bookmark-fixture', title: 'Bookmark fixture', url: 'https://bookmark.example/' };
    chrome.bookmarks = { getRecent: async () => [bookmark], search: async () => [bookmark] };
    chrome.history = { search: async options => {
      globalThis.historyRequest = options;
      return [{ id: 'fixture', title: 'History fixture', url: 'https://history.example/' }];
    } };
  }, names);
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
  await settings.locator('.footer-settings').click();
  await choose(settings, 'Overlay', 'Open new tabs as an overlay', 'Off');
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
  await page.locator('.footer-settings').click();
  await choose(page, 'Search', 'Suggest searches as I type', 'On');
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'garden ideas' })).toBeVisible();
  await page.locator('.footer-settings').click();
  await choose(page, 'Search', 'Suggest searches as I type', 'Off');
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete is off');
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))).toBe(true);
  await choose(page, 'Search', 'Suggest searches as I type', 'On');
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await choose(page, 'Overlay', 'Open new tabs as an overlay', 'Off');
  await expect(page.locator('#settings-status')).toContainText('New-tab overlay is off');
  await expect(page.locator('#settings-status')).toContainText('Enable search suggestions again');
  await chosen(page, 'Search', 'Suggest searches as I type', 'Off');
  await grantAutocompleteHost(page);
  await choose(page, 'Search', 'Suggest searches as I type', 'On');
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('combobox').fill('weather');
  await expect(page.getByRole('option').filter({ hasText: 'weather ideas' })).toBeVisible();
});

test('new-tab routing loads browser tabs and switches to a selected tab', async () => {
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
  await page.locator('.footer-settings').click();
  await choose(page, 'Search', 'Search with', 'DuckDuckGo');
  await choose(page, 'Appearance', 'Theme', 'Dark');
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
  await choose(frame, 'Appearance', 'Theme', 'Dark');
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
  await expect(frame.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
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
  await choose(frame, 'Appearance', 'Theme', 'Dark');
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
  await expect(frame.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.screenshot({ clip })).toEqual(background);
  // Outside clicks first close settings, then dismiss the command bar.
  await page.mouse.click(40, 40);
  await expect(frame.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
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
  await sibling.locator('.footer-settings').click();
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
    await page.locator('.footer-settings').click();
    const count = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    await trigger(page);
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('keep my search');
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(count);
    await expect(sibling.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
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
  await page.locator('.footer-settings').click();
  await chosen(page, 'Search', 'Suggest searches as I type', 'Off');
  await grantAutocompleteHost(page);
  await choose(page, 'Search', 'Suggest searches as I type', 'On');
  await expect(page.locator('#settings-status')).toContainText('Query autocomplete enabled');
  await choose(page, 'Search', 'Search with', 'Bing');
  await page.screenshot({ path: 'test-results/autocomplete-settings.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'weather tomorrow' })).toBeVisible();
  expect(requests).toEqual(['weather']);
  await expect(page.getByRole('option').filter({ hasText: 'weather tomorrow' })).toContainText('Suggestion');
  await page.screenshot({ path: 'test-results/autocomplete-results.png', animations: 'disabled' });
  await context.route('https://www.bing.com/search**', route => route.fulfill({ body: 'Search completed.' }));
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL('https://www.bing.com/search?q=weather%20tomorrow');
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.locator('.footer-settings').click();
  await chosen(page, 'Search', 'Suggest searches as I type', 'On');
  await choose(page, 'Search', 'Suggest searches as I type', 'Off');
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
  await page.locator('.footer-settings').click();
  await choose(page, 'Search', 'Suggest searches as I type', 'On');
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
  await expect(page.getByRole('option').first()).toContainText('with your default engine');
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
  await page.locator('.footer-settings').click();
  await chosen(page, 'Search', 'Suggest searches as I type', 'Off');
});

test('custom engines validate addresses, encode queries, and respect the new-tab preference', async () => {
  const page = await commandPage();
  await page.locator('.footer-settings').click();
  await choose(page, 'Search', 'Search with', 'Something else…');
  const address = page.getByRole('textbox', { name: 'Search address' });
  for (const value of ['javascript:alert("%s")', 'http://example.com/search?q=%s', 'http://localhost:3000/?q=%s']) {
    await address.fill(value);
    await address.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    expect((await worker.evaluate(() => chrome.storage.local.get('settings'))).settings.customUrl).toBe('');
  }
  await context.route('https://custom-search.example/**', route => route.fulfill({ body: 'Custom search destination.' }));
  await address.fill('https://custom-search.example/search?q=%s');
  await address.press('Enter');
  await expect(address).toHaveAttribute('aria-invalid', 'false');
  await choose(page, 'Search', 'Open results in', 'A new tab');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await page.getByRole('combobox').fill('tea & café');
  const created = context.waitForEvent('page');
  await page.getByRole('combobox').press('Enter');
  const destination = await created;
  await expect(destination).toHaveURL('https://custom-search.example/search?q=tea%20%26%20caf%C3%A9');
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/newtab.html`);
});

test('overlay remembers movement only when enabled, honors outside dismissal, and clips square corners', async () => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixture');
  const open = async () => {
    await trigger(page);
    await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
    const frame = page.frames().find(f => f.url().includes('mode=overlay'));
    await expect(frame.getByRole('combobox')).toBeVisible();
    return frame;
  };
  let frame = await open();
  await frame.locator('.footer-settings').click();
  await choose(frame, 'Overlay', 'Remember where I moved it', 'On');
  await choose(frame, 'Overlay', 'Close when I click outside', 'Off');
  await section(frame, 'Appearance');
  for (let i = 0; i < 7; i++) await frame.getByRole('button', { name: 'Decrease roundness' }).click();
  await expect(frame.locator('.palette')).toHaveCSS('border-radius', '0px');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  const clipPath = await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url.endsWith('/fixture'));
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__diaCommandBar.frame.style.clipPath });
    return result.result;
  });
  expect(clipPath).toContain('inset(');
  // The isolated host world reports a square clip (CSS omits a zero radius).
  expect(clipPath).not.toMatch(/round (?!0px)/);
  const handle = frame.getByRole('button', { name: 'Move command bar', exact: true });
  await handle.focus(); await handle.press('Shift+ArrowRight'); await handle.press('Shift+ArrowDown');
  const moved = await frame.locator('.stage').boundingBox();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('overlayPosition')).overlayPosition)).toEqual({ x: moved.x, y: moved.y });
  await page.mouse.click(30, 30);
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(1);
  await frame.getByRole('combobox').press('Escape');
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
  frame = await open();
  await expect.poll(async () => (await frame.locator('.stage').boundingBox()).x).toBe(moved.x);
  await expect.poll(async () => (await frame.locator('.stage').boundingBox()).y).toBe(moved.y);
  await frame.locator('.footer-settings').click();
  await choose(frame, 'Overlay', 'Remember where I moved it', 'Off');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await frame.getByRole('combobox').press('Escape');
  frame = await open();
  const centered = await frame.locator('.stage').boundingBox();
  expect(centered.x + centered.width / 2).toBeCloseTo(720);
  expect(await worker.evaluate(async () => (await chrome.storage.session.get('overlayPosition')).overlayPosition)).toBeUndefined();
  await frame.locator('.footer-settings').click();
  await frame.getByRole('button', { name: 'Restore defaults' }).click();
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await page.mouse.click(30, 30);
  await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
});

test('source windows, history range, and permission-backed state reach the worker', async () => {
  await grantSourceFixtures(['history']);
  const page = await commandPage();
  await worker.evaluate(() => chrome.windows.create({ url: 'http://127.0.0.1:4173/newtab.html?another-window', focused: false }));
  await page.bringToFront();
  await page.getByRole('combobox').fill('@ another-window');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.locator('.footer-settings').click();
  await choose(page, 'Sources', 'Include tabs from other windows', 'Off');
  await chosen(page, 'Sources', 'Search my history', 'On');
  await choose(page, 'Sources', 'Look back', 'A week');
  const request = await worker.evaluate(() => globalThis.historyRequest);
  expect(Math.abs(request.startTime - (Date.now() - 7 * 86400000))).toBeLessThan(10000);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.getByRole('combobox').fill('# history');
  await expect(page.getByRole('option')).toContainText('History fixture');
  await page.locator('.footer-settings').click();
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('#settings-status')).toContainText('Optional permissions removed');
  await chosen(page, 'Sources', 'Search my history', 'Off');
  expect((await worker.evaluate(() => chrome.storage.local.get('settings'))).settings.historyDays).toBe(90);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await page.getByRole('combobox').fill('# history');
  await expect(page.getByText('Searching history is off.')).toBeVisible();
});

test('CSP blocks other endpoints in the page and worker even with broad website access', async () => {
  const page = await commandPage();
  await enableNewTabOverlay(page);
  const requests = [];
  await context.route(/https?:\/\/(blocked\.example|suggestqueries\.google\.com)\//, route => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '["weather",["weather tomorrow"]]' });
  });
  const blocked = ['https://blocked.example/data', 'http://blocked.example/data', 'https://suggestqueries.google.com/not-autocomplete'];
  for (const target of [page, worker]) {
    const outcomes = await target.evaluate(async urls => Promise.all(urls.map(async url => {
      try { await fetch(url); return 'allowed'; } catch { return 'blocked'; }
    })), blocked);
    expect(outcomes).toEqual(['blocked', 'blocked', 'blocked']);
    expect(await target.evaluate(async () => (await fetch('https://suggestqueries.google.com/complete/search?q=weather')).ok)).toBe(true);
  }
  expect(requests).toEqual(Array(2).fill('https://suggestqueries.google.com/complete/search?q=weather'));
  await page.evaluate(() => new Promise(resolve => {
    const image = new Image(); image.onload = () => resolve(); image.onerror = () => resolve();
    image.src = 'https://blocked.example/tracker.png';
  }));
  expect(requests).toHaveLength(2);
});

test('stored HTTP custom engines cannot navigate or silently send searches elsewhere', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ settings: { engine: 'custom', customUrl: 'http://legacy-search.example/?q=%s' } }));
  const page = await commandPage();
  const count = context.pages().length;
  await page.getByRole('combobox').fill('private words');
  await page.getByRole('combobox').press('Enter');
  await expect(page.locator('#status')).toContainText('valid HTTPS search address');
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/newtab.html`);
  expect(context.pages()).toHaveLength(count);
  await page.locator('.footer-settings').click();
  await section(page, 'Search');
  await expect(page.getByRole('textbox', { name: 'Search address' })).toHaveValue('');
});

test('Restore defaults revokes optional grants, cancels suggestions, and lets an automatic overlay close', async () => {
  await grantSourceFixtures(['bookmarks', 'history']);
  const settings = await commandPage();
  await grantAutocompleteHost(settings);
  await enableNewTabOverlay(settings);
  await settings.locator('.footer-settings').click();
  await choose(settings, 'Search', 'Suggest searches as I type', 'On');
  await settings.getByRole('button', { name: 'Close settings' }).click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await context.route('https://suggestqueries.google.com/complete/search**', async route => {
    requests++; await gate;
    await route.fulfill({ contentType: 'application/json', body: '["weather",["weather tomorrow"]]' }).catch(() => {});
  });
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4173/fixture');
  await source.getByRole('textbox', { name: 'Original field' }).focus();
  await source.bringToFront();
  // This path has broad host access but no toolbar/shortcut activeTab grant.
  const placeholder = await worker.evaluate(() => chrome.tabs.create({}));
  await expect.poll(() => source.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  await expect.poll(() => worker.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), placeholder.id)).toBe(false);
  const frame = source.frames().find(f => f.url().includes('mode=overlay'));
  await expect(frame.getByRole('combobox')).toBeVisible();
  await frame.locator('.footer-settings').click();
  await worker.evaluate(() => chrome.storage.session.set({ overlayPosition: { x: 80, y: 90 } }));
  const pending = settings.evaluate(() => chrome.runtime.sendMessage({ type: 'autocomplete', input: 'weather', filter: 'all' }));
  await expect.poll(() => requests).toBe(1);
  await frame.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(frame.locator('#settings-status')).toContainText('Optional permissions removed');
  expect((await pending).data.suggestions).toEqual([]);
  release();
  const grants = await worker.evaluate(() => chrome.permissions.getAll());
  expect(grants.origins || []).toEqual([]);
  expect(grants.permissions).not.toContain('bookmarks');
  expect(grants.permissions).not.toContain('history');
  expect(grants.permissions).toEqual(expect.arrayContaining(['tabs', 'activeTab', 'storage', 'scripting', 'search']));
  expect(await worker.evaluate(() => globalThis.removedSourceGrants.sort())).toEqual(['bookmarks', 'history']);
  expect(await worker.evaluate(async () => (await chrome.storage.session.get('overlayPosition')).overlayPosition)).toBeUndefined();
  await chosen(frame, 'Sources', 'Search my bookmarks', 'Off');
  await chosen(frame, 'Sources', 'Search my history', 'Off');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await frame.getByRole('combobox').fill('weather');
  await source.waitForTimeout(350);
  expect(requests).toBe(1);
  await frame.getByRole('combobox').press('Escape');
  await frame.getByRole('combobox').press('Escape');
  await expect(source.locator('[data-dia-command-bar]')).toHaveCount(0);
  await expect(source.getByRole('textbox', { name: 'Original field' })).toBeFocused();
});

test('Restore defaults reports failed revocation and can retry without re-enabling opt-ins', async () => {
  const page = await commandPage();
  await enableNewTabOverlay(page);
  await worker.evaluate(() => {
    globalThis.realRemove = chrome.permissions.remove.bind(chrome.permissions);
    chrome.permissions.remove = async () => false;
  });
  await page.locator('.footer-settings').click();
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('#settings-status')).toContainText('some permissions could not be removed');
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))).toBe(true);
  const saved = (await worker.evaluate(() => chrome.storage.local.get('settings'))).settings;
  expect(saved.autocomplete).toBe(false); expect(saved.newTabOverlay).toBe(false);
  await worker.evaluate(() => { chrome.permissions.remove = globalThis.realRemove; });
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('#settings-status')).toContainText('Optional permissions removed');
  expect((await worker.evaluate(() => chrome.permissions.getAll())).origins || []).toEqual([]);
});

test('navigation after revoking overlay permission closes the existing UI and preserves the website', async () => {
  const settings = await commandPage();
  await enableNewTabOverlay(settings);
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4173/fixture');
  await source.bringToFront();
  const placeholder = await worker.evaluate(() => chrome.tabs.create({}));
  await expect.poll(() => source.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  await expect.poll(() => worker.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), placeholder.id)).toBe(false);
  const frame = source.frames().find(f => f.url().includes('mode=overlay'));
  await frame.locator('.footer-settings').click();
  await frame.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(frame.locator('#settings-status')).toContainText('Optional permissions removed');
  await frame.getByRole('button', { name: 'Close settings' }).click();
  await frame.getByRole('combobox').fill('http://127.0.0.1:4173/newtab.html?after-reset');
  const created = context.waitForEvent('page');
  await frame.getByRole('combobox').press('Enter');
  await expect(await created).toHaveURL('http://127.0.0.1:4173/newtab.html?after-reset');
  await expect(source.locator('[data-dia-command-bar]')).toHaveCount(0);
  await expect(source).toHaveURL('http://127.0.0.1:4173/fixture');
  await expect(source.getByRole('textbox', { name: 'Original field' })).toHaveValue('Keep this text');
});

test('Restore defaults also removes individual-site grants without the wildcard overlay grant', async () => {
  const page = await commandPage();
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(id => chrome.developerPrivate.addHostPermission(id, 'https://specific.example/*'), extensionId);
  await manager.close();
  await page.bringToFront();
  expect(await page.evaluate(() => chrome.permissions.request({ origins: ['https://specific.example/*'] }))).toBe(true);
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://specific.example/*'] }))).toBe(true);
  await page.locator('.footer-settings').click();
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('#settings-status')).toContainText('Optional permissions removed');
  expect((await worker.evaluate(() => chrome.permissions.getAll())).origins || []).toEqual([]);
});

test('separate new-tab page can be disabled and restored without disabling the extension', async () => {
  const settings = await commandPage();
  await settings.locator('.footer-settings').click();
  await choose(settings, 'New tab', 'Use a separate command page', 'Off');
  await settings.reload();
  await settings.locator('.footer-settings').click();
  await chosen(settings, 'New tab', 'Use a separate command page', 'Off');
  const next = context.waitForEvent('page');
  const tab = await worker.evaluate(() => chrome.tabs.create({}));
  const native = await next;
  await expect.poll(() => worker.evaluate(id => chrome.tabs.get(id).then(t => t.status), tab.id)).toBe('complete');
  await expect(native).toHaveURL(/chrome:\/\/(?:newtab|new-tab-page)\//);
  await expect(native.getByRole('combobox', { name: 'Search tabs, bookmarks, history, or the web' })).toHaveCount(0);
  // Restricted pages still offer a command page through an explicit invocation.
  const fallback = context.waitForEvent('page'); await trigger(native);
  await expect((await fallback).getByRole('combobox')).toBeVisible();
  await settings.bringToFront();
  await choose(settings, 'New tab', 'Use a separate command page', 'On');
  const restored = context.waitForEvent('page');
  await worker.evaluate(() => chrome.tabs.create({}));
  await expect((await restored).getByRole('combobox')).toBeVisible();
  await expect(native).toHaveURL(/chrome:\/\/(?:newtab|new-tab-page)\//);
});

test('overlay-only mode keeps native homes on restricted pages and in new windows', async () => {
  const settings = await commandPage();
  await enableNewTabOverlay(settings);
  await settings.locator('.footer-settings').click();
  await choose(settings, 'New tab', 'Use a separate command page', 'Off');
  const source = await context.newPage(); await source.goto('http://127.0.0.1:4173/fixture');
  await source.bringToFront();
  const placeholder = await worker.evaluate(() => chrome.tabs.create({}));
  await expect.poll(() => worker.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), placeholder.id)).toBe(false);
  await expect.poll(() => source.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
  await source.frames().find(f => f.url().includes('mode=overlay')).getByRole('combobox').press('Escape');
  await source.goto('chrome://version/'); await source.bringToFront();
  let next = context.waitForEvent('page');
  const restricted = await worker.evaluate(() => chrome.tabs.create({}));
  const native = await next;
  await expect.poll(() => worker.evaluate(id => chrome.tabs.get(id).then(t => t.status), restricted.id)).toBe('complete');
  await expect(native).toHaveURL(/chrome:\/\/(?:newtab|new-tab-page)\//);
  next = context.waitForEvent('page');
  await worker.evaluate(() => chrome.windows.create({}));
  await expect(await next).toHaveURL(/chrome:\/\/(?:newtab|new-tab-page)\//);
});

test('every open-results choice works from overlays and modifier Enter forces a new tab', async () => {
  const source = await context.newPage(); await source.goto('http://127.0.0.1:4173/fixture');
  for (const [choice, modified, newTab] of [['Automatic', false, true], ['A new tab', false, true], ['This tab', true, true], ['This tab', false, false]]) {
    await trigger(source);
    await expect.poll(() => source.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
    const frame = source.frames().find(f => f.url().includes('mode=overlay'));
    await frame.locator('.footer-settings').click();
    await choose(frame, 'Search', 'Open results in', choice);
    await frame.getByRole('button', { name: 'Close settings' }).click();
    const destination = `http://127.0.0.1:4173/newtab.html?choice=${encodeURIComponent(choice)}&modified=${modified}`;
    await frame.getByRole('combobox').fill(destination);
    const next = newTab ? context.waitForEvent('page') : Promise.resolve(source);
    await frame.getByRole('combobox').press(modified ? 'Control+Enter' : 'Enter');
    const opened = await next;
    await expect(opened).toHaveURL(destination);
    if (newTab) { await expect(source).toHaveURL('http://127.0.0.1:4173/fixture'); await opened.close(); }
    await expect(source.locator('[data-dia-command-bar]')).toHaveCount(0);
  }
});

test('all built-in search engines navigate to their selected provider and shortcuts open browser settings', async () => {
  const page = await commandPage();
  await context.route(/https:\/\/(www\.google\.com|duckduckgo\.com|www\.bing\.com|search\.brave\.com)\//, route => route.fulfill({ body: 'Search result' }));
  for (const [name, prefix] of [['Google', 'https://www.google.com/search?q='], ['DuckDuckGo', 'https://duckduckgo.com/?q='], ['Bing', 'https://www.bing.com/search?q='], ['Brave', 'https://search.brave.com/search?q=']]) {
    await page.goto(`chrome-extension://${extensionId}/newtab.html`);
    await page.locator('.footer-settings').click();
    await choose(page, 'Search', 'Search with', name);
    await choose(page, 'Search', 'Open results in', 'This tab');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('combobox').fill('tea & coffee'); await page.getByRole('combobox').press('Enter');
    await expect(page).toHaveURL(`${prefix}tea%20%26%20coffee`);
  }
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.locator('.footer-settings').click(); await section(page, 'Shortcuts');
  const next = context.waitForEvent('page'); await page.getByRole('button', { name: 'Change…' }).click();
  await expect(await next).toHaveURL('chrome://extensions/shortcuts');
});

test('bookmark and history controls enable and revoke sources, honor history ranges, and recover from denial', async () => {
  await grantSourceFixtures([]);
  const page = await commandPage();
  // Native API permission prompts cannot be accepted headlessly. Only their
  // grant/deny result is simulated; the real UI and worker data flow execute.
  await page.exposeFunction('sourcePermissionFixture', async (names, enabled) => worker.evaluate(({ names, enabled }) => {
    for (const name of names) enabled ? globalThis.sourceGrants.add(name) : globalThis.sourceGrants.delete(name);
    return true;
  }, { names, enabled }));
  await page.evaluate(() => {
    chrome.permissions.request = options => window.sourcePermissionFixture(options.permissions, true);
    chrome.permissions.remove = options => window.sourcePermissionFixture(options.permissions, false);
  });
  await page.locator('.footer-settings').click();
  for (const [name, prefix, title] of [['bookmarks', '*', 'Bookmark fixture'], ['history', '#', 'History fixture']]) {
    await choose(page, 'Sources', `Search my ${name}`, 'On');
    if (name === 'history') for (const [label, days] of [['A week', 7], ['A month', 30], ['3 months', 90]]) {
      await choose(page, 'Sources', 'Look back', label);
      const request = await worker.evaluate(() => globalThis.historyRequest);
      expect(Math.abs(request.startTime - (Date.now() - days * 86400000))).toBeLessThan(10000);
    }
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('combobox').fill(`${prefix} fixture`);
    await expect(page.getByRole('option')).toContainText(title);
    await page.locator('.footer-settings').click();
    await choose(page, 'Sources', `Search my ${name}`, 'Off');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByText(`Searching ${name} is off.`)).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.locator('.footer-settings').click();
  }
  await page.evaluate(() => { chrome.permissions.request = async () => false; });
  await section(page, 'Sources');
  await page.getByRole('group', { name: 'Search my bookmarks', exact: true }).getByRole('button', { name: 'On', exact: true }).click();
  await expect(page.locator('#settings-status')).toContainText('Access was not granted');
  await chosen(page, 'Sources', 'Search my bookmarks', 'Off');
});

test('font choices persist in the extension and appear in reopened overlays', async () => {
  const page = await context.newPage(); await page.goto('http://127.0.0.1:4173/fixture');
  for (const [name, font] of [['Serif', /Iowan Old Style/], ['Mono', /monospace/], ['Dia', /ABC Oracle/]]) {
    await trigger(page);
    await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
    let frame = page.frames().find(f => f.url().includes('mode=overlay'));
    await frame.locator('.footer-settings').click();
    await choose(frame, 'Appearance', 'Font', name);
    await expect(frame.locator('#query')).toHaveCSS('font-family', font);
    await frame.getByRole('button', { name: 'Close settings' }).click();
    await frame.getByRole('combobox').press('Escape');
    await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
    await trigger(page);
    await expect.poll(() => page.frames().find(f => f.url().includes('mode=overlay'))?.url()).toBeTruthy();
    frame = page.frames().find(f => f.url().includes('mode=overlay'));
    for (const selector of ['#query', '.result-title', '.palette-footer', 'kbd']) await expect(frame.locator(selector).first()).toHaveCSS('font-family', font);
    await frame.getByRole('combobox').press('Escape');
    await expect(page.locator('[data-dia-command-bar]')).toHaveCount(0);
  }
});
