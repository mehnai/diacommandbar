import { OVERLAY_ORIGINS } from './core.js';

// Cmd/Ctrl+T is reserved by the browser. Route only a freshly created native
// new tab, and close its placeholder only after an overlay has acknowledged it.
export function createNewTabRouter({ browser, pageUrl, openOverlay, dismissOverlay, now = Date.now }) {
  const activeKey = windowId => `active-tab:${windowId}`;
  const pendingKey = tabId => `new-tab:${tabId}`;
  // Dia bypasses chrome_url_overrides and uses a start-page UUID instead.
  // Ignore deeper paths/query strings that may refer to an existing chat.
  const isDiaHome = url => /^(?:chrome|dia):\/\/start-page\/(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/?)?$/i.test(url || '');
  const isNewTab = url => url === pageUrl || isDiaHome(url) || /^(?:chrome|dia|arc):\/\/(?:newtab|new-tab-page)\/?$/.test(url || '');
  let queue = Promise.resolve();
  const serialize = operation => {
    const next = queue.then(operation);
    queue = next.catch(console.error);
    return next;
  };

  async function redirectDiaHome(tabId, expectedUrl) {
    const key = pendingKey(tabId);
    const record = (await browser.storage.session.get(key))[key];
    if (!record || record.redirected || now() - record.createdAt > 10000) return;
    try {
      const tab = await browser.tabs.get(tabId);
      const destination = tab.pendingUrl || tab.url;
      if (!tab.active || tab.pinned || tab.discarded || tab.windowId !== record.windowId || destination !== expectedUrl || !isDiaHome(destination)) return;
      // Claim once before navigating. The command page will consume this same
      // record for the optional overlay handoff when a previous website exists.
      await browser.storage.session.set({ [key]: { ...record, redirected: true } });
      await browser.tabs.update(tabId, { url: pageUrl });
    } catch {
      await browser.storage.session.remove(key); // The tab may have closed.
    }
  }

  // Keep the previous selection across service-worker suspension. Do not guess
  // a website when no previous selection in this window has been observed.
  serialize(async () => {
    for (const tab of await browser.tabs.query({ active: true })) {
      const key = activeKey(tab.windowId);
      if ((await browser.storage.session.get(key))[key] === undefined) await browser.storage.session.set({ [key]: tab.id });
    }
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    serialize(async () => {
      await browser.storage.session.set({ [activeKey(windowId)]: tabId });
      const record = (await browser.storage.session.get(pendingKey(tabId)))[pendingKey(tabId)];
      if (!record || record.redirected || now() - record.createdAt > 10000) return;
      // Dia creates an inactive placeholder with an opener, then activates it.
      // Either activation or the subsequent URL event can arrive first.
      const tab = await browser.tabs.get(tabId).catch(() => null);
      const url = tab?.pendingUrl || tab?.url;
      if (isDiaHome(url)) await redirectDiaHome(tabId, url);
    });
  });
  browser.tabs.onCreated.addListener(tab => {
    // Explicit destinations, background tabs, and restored/discarded tabs must
    // never be treated as disposable new-tab placeholders.
    const url = tab.pendingUrl || tab.url;
    if (tab.pinned || tab.discarded || (url && url !== 'about:blank' && (!isNewTab(url) || url === pageUrl))) return;
    const createdAt = now();
    serialize(async () => {
      const sourceId = (await browser.storage.session.get(activeKey(tab.windowId)))[activeKey(tab.windowId)];
      const canHandoff = tab.active && tab.openerTabId === undefined && url !== 'about:blank';
      await browser.storage.session.set({ [pendingKey(tab.id)]: { sourceId: sourceId === tab.id ? undefined : sourceId, windowId: tab.windowId, createdAt, canHandoff } });
      if (isDiaHome(url)) await redirectDiaHome(tab.id, url);
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (isDiaHome(change.url)) serialize(() => redirectDiaHome(tabId, change.url));
    else if (change.url && !isNewTab(change.url)) serialize(() => browser.storage.session.remove(pendingKey(tabId)));
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
    if (!record?.sourceId || (!record.canHandoff && !record.redirected) || now() - record.createdAt > 10000) return { routed: false };
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
