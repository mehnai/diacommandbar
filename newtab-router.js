import { normalizeSettings, OVERLAY_ORIGINS } from './core.js';

// Observe fresh native tabs instead of declaring an unconditional manifest
// override. This lets users keep their browser's homepage without a reload.
export function createNewTabRouter({ browser, pageUrl, openOverlay, dismissOverlay, now = Date.now }) {
  const activeKey = windowId => `active-tab:${windowId}`;
  const pendingKey = tabId => `new-tab:${tabId}`;
  // Dia's homepage can carry a UUID. Deeper paths and query strings may be chats.
  const isDiaHome = url => /^(?:chrome|dia):\/\/start-page\/(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/?)?$/i.test(url || '');
  const isNativeNewTab = url => isDiaHome(url) || /^(?:chrome|dia|arc):\/\/(?:newtab|new-tab-page)\/?$/.test(url || '');
  let queue = Promise.resolve();
  const serialize = operation => {
    const next = queue.then(operation);
    queue = next.catch(console.error);
    return next;
  };
  const preferences = async () => normalizeSettings((await browser.storage.local.get('settings')).settings);

  async function route(tabId) {
    const key = pendingKey(tabId);
    const record = (await browser.storage.session.get(key))[key];
    if (!record || now() - record.createdAt > 10000) return;
    let opened = false;
    try {
      const placeholder = await browser.tabs.get(tabId);
      const originalUrl = placeholder.pendingUrl || placeholder.url;
      const unchanged = tab => tab.windowId === record.windowId && !tab.pinned && !tab.discarded
        && (tab.pendingUrl || tab.url) === originalUrl && isNativeNewTab(originalUrl);
      if (!placeholder.active || !unchanged(placeholder)) return;
      // Consume once, including when disabled. Later settings changes and tab
      // switches must never replace an existing native page.
      await browser.storage.session.remove(key);
      const settings = await preferences();
      const canHandoff = record.canHandoff || isDiaHome(originalUrl);
      const source = record.sourceId && await browser.tabs.get(record.sourceId).catch(() => null);
      if (settings.newTabOverlay && canHandoff && source && source.windowId === record.windowId
        && !source.discarded && /^https?:\/\//.test(source.url || '')
        && await browser.permissions.contains({ origins: OVERLAY_ORIGINS })) {
        opened = await openOverlay(source);
        if (opened) {
          // Injection is asynchronous: keep pages the user navigated, moved,
          // or switched to, and honor settings changed during the handoff.
          const current = await browser.tabs.get(tabId);
          const currentSource = await browser.tabs.get(source.id);
          if (current.active && unchanged(current) && currentSource.windowId === record.windowId
            && currentSource.url === source.url && !currentSource.pendingUrl && (await preferences()).newTabOverlay) {
            await browser.tabs.update(source.id, { active: true });
            if (unchanged(await browser.tabs.get(tabId))) {
              await browser.tabs.remove(tabId);
              opened = false; // The website keeps its acknowledged overlay.
              return;
            }
          }
          // If the user interrupted a handoff, leave the native tab untouched.
          return;
        }
      }
      if ((await preferences()).newTabPage) {
        const current = await browser.tabs.get(tabId);
        if (current.active && unchanged(current)) await browser.tabs.update(tabId, { url: pageUrl });
      }
    } catch { /* A candidate or its source may have closed. */ }
    finally { if (opened) await dismissOverlay(record.sourceId); }
  }

  // Persist the observed selection across worker suspension; do not guess a
  // previous website in a window where no selection has been observed.
  serialize(async () => {
    for (const tab of await browser.tabs.query({ active: true })) {
      const key = activeKey(tab.windowId);
      if ((await browser.storage.session.get(key))[key] === undefined) await browser.storage.session.set({ [key]: tab.id });
    }
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    serialize(async () => {
      await browser.storage.session.set({ [activeKey(windowId)]: tabId });
      await route(tabId);
    });
  });
  browser.tabs.onCreated.addListener(tab => {
    const url = tab.pendingUrl || tab.url;
    if (tab.pinned || tab.discarded || (url && url !== 'about:blank' && !isNativeNewTab(url))) return;
    const createdAt = now();
    serialize(async () => {
      const sourceId = (await browser.storage.session.get(activeKey(tab.windowId)))[activeKey(tab.windowId)];
      const canHandoff = tab.active && tab.openerTabId === undefined && url !== 'about:blank';
      await browser.storage.session.set({ [pendingKey(tab.id)]: { sourceId: sourceId === tab.id ? undefined : sourceId, windowId: tab.windowId, createdAt, canHandoff } });
      await route(tab.id);
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (isNativeNewTab(change.url)) serialize(() => route(tabId));
    else if (change.url && change.url !== 'about:blank') serialize(() => browser.storage.session.remove(pendingKey(tabId)));
  });
  browser.tabs.onRemoved.addListener(tabId => { serialize(() => browser.storage.session.remove(pendingKey(tabId))); });
  browser.windows.onRemoved.addListener(windowId => { serialize(() => browser.storage.session.remove(activeKey(windowId))); });
}
