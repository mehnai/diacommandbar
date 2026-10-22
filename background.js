import { DEFAULT_SETTINGS, ENGINES, toNavigableUrl, AUTOCOMPLETE_ORIGIN, OVERLAY_ORIGINS } from './core.js';
import { createAutocompleteService } from './autocomplete.js';
import { createNewTabRouter } from './newtab-router.js';

const pageUrl = chrome.runtime.getURL('newtab.html');
const overlayKey = tabId => `overlay:${tabId}`;
let settingsQueue = Promise.resolve();
const allowedSettings = {
  theme: ['system', 'light', 'dark'], accent: ['lilac', 'sage', 'rose', 'sand'],
  engine: ['default', ...Object.keys(ENGINES)], autocomplete: [true, false], newTabOverlay: [true, false],
};
const autocomplete = createAutocompleteService({ isAllowed: async () => {
  const { settings } = await chrome.storage.local.get('settings');
  return settings?.autocomplete === true && await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] });
} });
const autocompleteClient = sender => `${sender.tab?.id}:${sender.documentId || sender.frameId}`;

async function authorized(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  if (`${url.protocol}//${url.host}${url.pathname}` !== pageUrl) return false;
  if (sender.frameId === 0 && url.searchParams.get('mode') !== 'overlay') return true;
  if (!sender.tab?.id || url.searchParams.get('mode') !== 'overlay') return false;
  const state = (await chrome.storage.session.get(overlayKey(sender.tab.id)))[overlayKey(sender.tab.id)];
  return !!state && state.token === url.searchParams.get('token');
}

async function dismissOverlay(tabId) {
  if (!tabId) return;
  await chrome.storage.session.remove(overlayKey(tabId));
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const overlay = globalThis.__diaCommandBar;
      if (!overlay) return;
      overlay.host.remove();
      if (overlay.previousFocus?.isConnected) overlay.previousFocus.focus({ preventScroll: true });
      delete globalThis.__diaCommandBar;
    } });
  } catch { /* The source page may have navigated or closed. */ }
}

async function openPalette(tab, { fallback = true, toggle = true } = {}) {
  if (!tab?.id) {
    if (fallback) await chrome.tabs.create({ url: `${pageUrl}?source=shortcut` });
    return false;
  }
  if (tab.url?.startsWith(pageUrl)) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('#query')?.focus() });
    return false;
  }
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [overlayKey(tab.id)]: { token, ready: false } });
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (url, toggle) => {
        if (globalThis.__diaCommandBar) {
          const old = globalThis.__diaCommandBar;
          old.host.remove();
          if (old.previousFocus?.isConnected) old.previousFocus.focus({ preventScroll: true });
          delete globalThis.__diaCommandBar;
          if (toggle) return 'closed';
        }
        const previousFocus = document.activeElement;
        const host = document.createElement('div');
        host.setAttribute('data-dia-command-bar', '');
        for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'z-index': '2147483647', display: 'block', 'background-color': 'rgba(28, 22, 40, .18)', 'backdrop-filter': 'blur(5px)' })) host.style.setProperty(key, value, 'important');
        const shadow = host.attachShadow({ mode: 'closed' });
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.title = 'Dia Command Bar';
        frame.style.cssText = 'position:absolute;inset:0;border:0;width:100%;height:100%;color-scheme:normal;background:transparent;';
        shadow.append(frame);
        document.documentElement.append(host);
        globalThis.__diaCommandBar = { host, previousFocus, frame };
        frame.addEventListener('load', () => frame.focus(), { once: true });
        frame.focus();
        return 'opened';
      },
      args: [`${pageUrl}?mode=overlay&token=${encodeURIComponent(token)}`, toggle],
    });
    if (injection.result === 'closed') {
      await chrome.storage.session.remove(overlayKey(tab.id));
      return false;
    }
    // A page's frame policy can block an embedded extension. Fall back reliably.
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const state = (await chrome.storage.session.get(overlayKey(tab.id)))[overlayKey(tab.id)];
      if (!state || state.token !== token) return false;
      if (state.ready) return true;
    }
  } catch { /* Browser pages and the Web Store cannot accept injected scripts. */ }
  await dismissOverlay(tab.id);
  if (fallback) await chrome.tabs.create({ url: `${pageUrl}?source=shortcut`, windowId: tab.windowId });
  return false;
}

const routeNewTab = createNewTabRouter({
  browser: chrome, pageUrl,
  openOverlay: tab => openPalette(tab, { fallback: false, toggle: false }),
  dismissOverlay,
});

async function snapshot(message, sender) {
  const isOverlay = new URL(sender.url).searchParams.get('mode') === 'overlay';
  const saved = await chrome.storage.local.get('settings');
  const permissions = {
    bookmarks: await chrome.permissions.contains({ permissions: ['bookmarks'] }),
    history: await chrome.permissions.contains({ permissions: ['history'] }),
    autocomplete: await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }),
    newTabOverlay: await chrome.permissions.contains({ origins: OVERLAY_ORIGINS }),
  };
  const query = String(message.query || '').slice(0, 500);
  const warnings = [];
  const safe = async (operation, name) => {
    try { return await operation(); } catch { warnings.push(`Could not read ${name}. Try again or check its permission in settings.`); return []; }
  };
  const [tabs, bookmarks, history, shortcuts] = await Promise.all([
    safe(() => chrome.tabs.query({}), 'tabs'),
    permissions.bookmarks ? safe(() => query ? chrome.bookmarks.search(query) : chrome.bookmarks.getRecent(60), 'bookmarks') : [],
    permissions.history ? safe(() => chrome.history.search({ text: query, maxResults: 80, startTime: Date.now() - 90 * 86400000 }), 'history') : [],
    chrome.commands.getAll(),
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...saved.settings }, permissions, warnings, incognito: !!sender.tab?.incognito,
    tabs: tabs.filter(t => (isOverlay || t.id !== sender.tab?.id) && !t.url?.startsWith(chrome.runtime.getURL('')) && !/^(?:chrome|dia|arc):\/\/(?:newtab|new-tab-page)\/?(?:[?#].*)?$/.test(t.url || '') && toNavigableUrl(t.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).map(t => ({ id: t.id, windowId: t.windowId, title: t.title || t.url, url: t.url, pinned: t.pinned })),
    bookmarks: bookmarks.filter(b => b.url).slice(0, 80), history,
    shortcut: shortcuts.find(c => c.name === 'open-command-bar')?.shortcut || '',
  };
}

async function execute(message, sender) {
  const item = message.item;
  if (!item || typeof item.kind !== 'string') throw new Error('Choose a result first.');
  const overlay = new URL(sender.url).searchParams.get('mode') === 'overlay';
  const sourceId = sender.tab?.id;
  const newTab = overlay || !!message.newTab || !sourceId;
  const navigate = async url => {
    if (newTab) await chrome.tabs.create({ url, ...(sender.tab?.windowId ? { windowId: sender.tab.windowId } : {}) });
    else await chrome.tabs.update(sourceId, { url });
  };
  if (item.kind === 'tab') {
    if (!Number.isInteger(item.tabId)) throw new Error('This tab is no longer available.');
    const tab = await chrome.tabs.get(item.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else if (item.kind === 'search') {
    const query = String(item.query || '').trim().slice(0, 2000);
    if (!query) throw new Error('Enter something to search for.');
    const { settings } = await chrome.storage.local.get('settings');
    const engine = settings?.engine || 'default';
    if (ENGINES[engine]) await navigate(`${ENGINES[engine].url}${encodeURIComponent(query)}`);
    else if (newTab) await chrome.search.query({ text: query, disposition: 'NEW_TAB' });
    else await chrome.search.query({ text: query, tabId: sourceId });
  } else if (['url', 'bookmark', 'history'].includes(item.kind)) {
    const url = toNavigableUrl(String(item.url || ''));
    if (!url) throw new Error('That address cannot be opened.');
    await navigate(url);
  } else if (item.kind === 'command') {
    const destinations = { downloads: 'chrome://downloads/', bookmarks: 'chrome://bookmarks/', history: 'chrome://history/', extensions: 'chrome://extensions/', shortcuts: 'chrome://extensions/shortcuts' };
    if (item.id === 'new-window') await chrome.windows.create({});
    else if (destinations[item.id]) await navigate(destinations[item.id]);
    else throw new Error('That command is not available.');
  } else throw new Error('That result is not available.');
  if (overlay) await dismissOverlay(sourceId);
  return { done: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!(await authorized(sender))) throw new Error('Open the command bar using the extension button or shortcut.');
    if (message.type === 'route-new-tab') return routeNewTab(sender);
    if (message.type === 'overlay-ready') {
      if (new URL(sender.url).searchParams.get('mode') !== 'overlay') throw new Error('An overlay is required.');
      const key = overlayKey(sender.tab.id);
      const state = (await chrome.storage.session.get(key))[key];
      if (state?.token === new URL(sender.url).searchParams.get('token')) await chrome.storage.session.set({ [key]: { ...state, ready: true } });
      return {};
    }
    if (message.type === 'snapshot') return snapshot(message, sender);
    if (message.type === 'autocomplete') return autocomplete.request({ client: autocompleteClient(sender), input: message.input, filter: message.filter, incognito: !!sender.tab?.incognito });
    if (message.type === 'cancel-autocomplete') { autocomplete.cancel(autocompleteClient(sender)); return {}; }
    if (message.type === 'execute') return execute(message, sender);
    if (message.type === 'dismiss') { autocomplete.cancel(autocompleteClient(sender)); await dismissOverlay(sender.tab?.id); return {}; }
    if (message.type === 'settings') {
      const save = settingsQueue.catch(() => {}).then(async () => {
        const { settings = {} } = await chrome.storage.local.get('settings');
        if (message.settings?.autocomplete === true && !(await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }))) throw new Error('Allow Google access before enabling query autocomplete.');
        if (message.settings?.newTabOverlay === true && !(await chrome.permissions.contains({ origins: OVERLAY_ORIGINS }))) throw new Error('Allow website access before enabling new tabs as an overlay.');
        for (const [key, choices] of Object.entries(allowedSettings)) if (choices.includes(message.settings?.[key])) settings[key] = message.settings[key];
        await chrome.storage.local.set({ settings });
        return { settings: { ...DEFAULT_SETTINGS, ...settings } };
      });
      settingsQueue = save;
      return save;
    }
    throw new Error('Unknown command.');
  })().then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message || 'Something went wrong. Please try again.' }));
  return true;
});

chrome.action.onClicked.addListener(tab => { openPalette(tab).catch(console.error); });
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'open-command-bar') return;
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await openPalette(tab); } catch (error) { console.error(error); }
});
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(overlayKey(tabId)).catch(console.error); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue?.autocomplete !== true) autocomplete.cancelAll();
});
chrome.permissions.onRemoved.addListener(() => autocomplete.cancelAll());
