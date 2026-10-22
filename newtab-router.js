import { OVERLAY_ORIGINS } from './core.js';

// Cmd/Ctrl+T is reserved by the browser. Route only a freshly created native
// new tab, and close its placeholder only after an overlay has acknowledged it.
export function createNewTabRouter({ browser, pageUrl, openOverlay, dismissOverlay, now = Date.now }) {
  const activeKey = windowId => `active-tab:${windowId}`;
  const pendingKey = tabId => `new-tab:${tabId}`;
  const isNewTab = url => url === pageUrl || /^(?:chrome|dia|arc):\/\/(?:newtab|new-tab-page)\/?$/.test(url || '');
  let queue = Promise.resolve();
  const serialize = operation => {
    const next = queue.then(operation);
    queue = next.catch(console.error);
    return next;
  };

  // Keep the previous selection across service-worker suspension. Do not guess
  // a website when no previous selection in this window has been observed.
  serialize(async () => {
    for (const tab of await browser.tabs.query({ active: true })) {
      const key = activeKey(tab.windowId);
      if ((await browser.storage.session.get(key))[key] === undefined) await browser.storage.session.set({ [key]: tab.id });
    }
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    serialize(() => browser.storage.session.set({ [activeKey(windowId)]: tabId }));
  });
  browser.tabs.onCreated.addListener(tab => {
    // Explicit destinations, background tabs, and restored/discarded tabs must
    // never be treated as disposable new-tab placeholders.
    const url = tab.pendingUrl || tab.url;
    if (!tab.active || tab.discarded || (url && (!isNewTab(url) || url === pageUrl))) return;
    const createdAt = now();
    serialize(async () => {
      const sourceId = (await browser.storage.session.get(activeKey(tab.windowId)))[activeKey(tab.windowId)];
      if (!sourceId || sourceId === tab.id) return;
      await browser.storage.session.set({ [pendingKey(tab.id)]: { sourceId, windowId: tab.windowId, createdAt } });
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !isNewTab(change.url)) serialize(() => browser.storage.session.remove(pendingKey(tabId)));
  });
  browser.tabs.onRemoved.addListener(tabId => { serialize(() => browser.storage.session.remove(pendingKey(tabId))); });
  browser.windows.onRemoved.addListener(windowId => { serialize(() => browser.storage.session.remove(activeKey(windowId))); });

  return async function route(sender) {
    if (sender.frameId !== 0 || sender.url !== pageUrl || !sender.tab?.id) return { routed: false };
    const tabId = sender.tab.id;
    const record = await serialize(async () => {
      const key = pendingKey(tabId);
      const value = (await browser.storage.session.get(key))[key];
      await browser.storage.session.remove(key); // A reload can never try again.
      return value;
    });
    if (!record || now() - record.createdAt > 10000) return { routed: false };
    const { settings } = await browser.storage.local.get('settings');
    if (settings?.newTabOverlay !== true || !(await browser.permissions.contains({ origins: OVERLAY_ORIGINS }))) return { routed: false };

    let opened = false;
    try {
      const placeholder = await browser.tabs.get(tabId);
      const source = await browser.tabs.get(record.sourceId);
      const safePlaceholder = tab => tab.windowId === record.windowId && !tab.pinned && isNewTab(tab.url) && (!tab.pendingUrl || isNewTab(tab.pendingUrl));
      if (!placeholder.active || !safePlaceholder(placeholder) || source.windowId !== record.windowId || source.discarded || !/^https?:\/\//.test(source.url || '')) return { routed: false };
      opened = await openOverlay(source);
      if (!opened) return { routed: false, reason: 'This page cannot show an overlay. The command bar is available here.' };
      // The user may have typed an address or switched tabs during injection.
      const current = await browser.tabs.get(tabId);
      const currentSource = await browser.tabs.get(source.id);
      const latest = await browser.storage.local.get('settings');
      if (!current.active || !safePlaceholder(current) || currentSource.windowId !== record.windowId || currentSource.url !== source.url || currentSource.pendingUrl || latest.settings?.newTabOverlay !== true) return { routed: false };
      await browser.tabs.update(source.id, { active: true });
      const beforeClose = await browser.tabs.get(tabId);
      if (!safePlaceholder(beforeClose)) return { routed: false };
      await browser.tabs.remove(tabId);
      opened = false; // Keep the successfully transferred overlay.
      return { routed: true };
    } catch {
      return { routed: false };
    } finally {
      if (opened) await dismissOverlay(record.sourceId);
    }
  };
}
