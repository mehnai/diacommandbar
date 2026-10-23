import { DEFAULT_SETTINGS, normalizeSettings, settingsPatch, searchUrl, toNavigableUrl, AUTOCOMPLETE_ORIGIN, OVERLAY_ORIGINS } from './core.js';
import { createAutocompleteService } from './autocomplete.js';
import { createNewTabRouter } from './newtab-router.js';

const pageUrl = chrome.runtime.getURL('newtab.html');
const isCommandPage = url => typeof url === 'string' && url.split(/[?#]/, 1)[0] === pageUrl;
const overlayKey = tabId => `overlay:${tabId}`;
let settingsQueue = Promise.resolve();
let resettingPermissions = false;
const autocomplete = createAutocompleteService({ isAllowed: async () => {
  const { settings } = await chrome.storage.local.get('settings');
  return !resettingPermissions && settings?.autocomplete === true && await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] });
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
      overlay.cleanup?.();
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
  // New-tab overrides can retain a chrome:// URL in tabs.get/query. Confirm
  // that our document is loaded before treating such a tab as our own page.
  const nativeNewTab = /^(?:chrome|dia|arc):\/\/(?:newtab|new-tab-page)\/?(?:[?#].*)?$/.test(tab.url || '');
  const commandTab = isCommandPage(tab.url) || (nativeNewTab && (await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] })).some(context => isCommandPage(context.documentUrl)));
  if (commandTab) {
    // scripting.executeScript cannot target extension pages. Ask the page's
    // own code to focus its input, addressing only this tab.
    try {
      if ((await chrome.runtime.sendMessage({ type: 'focus-command-bar', tabId: tab.id }))?.focused) return false;
    } catch { /* An older page may have lost its listener after an update. */ }
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current && current.url === tab.url && !current.pendingUrl) await chrome.tabs.reload(tab.id);
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
          old.cleanup?.();
          old.host.remove();
          if (old.previousFocus?.isConnected) old.previousFocus.focus({ preventScroll: true });
          delete globalThis.__diaCommandBar;
          if (toggle) return 'closed';
        }
        const previousFocus = document.activeElement;
        const host = document.createElement('div');
        host.setAttribute('data-dia-command-bar', '');
        for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'z-index': '2147483647', display: 'block', 'background-color': 'transparent', 'backdrop-filter': 'none' })) host.style.setProperty(key, value, 'important');
        const shadow = host.attachShadow({ mode: 'closed' });
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.title = 'Dia Command Bar';
        // Clip to the actual controls. Some browser compositors paint an
        // opaque iframe canvas even when its document is transparent.
        frame.style.cssText = 'position:absolute;inset:0;border:0;width:100%;height:100%;color-scheme:normal;background:transparent;clip-path:inset(50%);';
        const frameUrl = new URL(url);
        const origin = `${frameUrl.protocol}//${frameUrl.host}`;
        const layout = event => {
          if (!event.isTrusted || event.source !== frame.contentWindow || event.origin !== origin) return;
          // The existing frame can clean up its own UI after Restore defaults
          // revokes the website grant needed for further script injection.
          if (event.data?.type === 'dia-command-bar-close') {
            window.removeEventListener('message', layout);
            host.remove();
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
            if (globalThis.__diaCommandBar?.host === host) delete globalThis.__diaCommandBar;
            return;
          }
          if (event.data?.type !== 'dia-command-bar-layout') return;
          const rect = event.data.rect;
          if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return;
          const [left, top, right, bottom] = rect;
          if (right <= left || bottom <= top) return;
          const radius = Number.isFinite(event.data.radius) ? Math.max(0, Math.min(28, event.data.radius)) : 14;
          frame.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(0, innerWidth - right)}px ${Math.max(0, innerHeight - bottom)}px ${Math.max(0, left)}px round ${radius}px)`;
        };
        window.addEventListener('message', layout);
        host.addEventListener('click', event => {
          if (event.target === host) frame.contentWindow.postMessage({ type: 'dia-command-bar-dismiss' }, origin);
        });
        shadow.append(frame);
        document.documentElement.append(host);
        globalThis.__diaCommandBar = { host, previousFocus, frame, cleanup: () => window.removeEventListener('message', layout) };
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
  const settings = normalizeSettings(saved.settings);
  const permissions = {
    bookmarks: await chrome.permissions.contains({ permissions: ['bookmarks'] }),
    history: await chrome.permissions.contains({ permissions: ['history'] }),
    autocomplete: await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }),
    newTabOverlay: await chrome.permissions.contains({ origins: OVERLAY_ORIGINS }),
  };
  if (resettingPermissions) for (const key of Object.keys(permissions)) permissions[key] = false;
  const query = String(message.query || '').slice(0, 500);
  // Source access always reflects real grants, including permissions retained
  // from older versions or revoked outside the extension.
  settings.bookmarks = permissions.bookmarks;
  settings.history = permissions.history;
  const warnings = [];
  const safe = async (operation, name) => {
    try { return await operation(); } catch { warnings.push(`Could not read ${name}. Try again or check its permission in settings.`); return []; }
  };
  const [tabs, bookmarks, history, shortcuts] = await Promise.all([
    safe(() => chrome.tabs.query(settings.allWindows ? {} : { windowId: sender.tab.windowId }), 'tabs'),
    permissions.bookmarks ? safe(() => query ? chrome.bookmarks.search(query) : chrome.bookmarks.getRecent(60), 'bookmarks') : [],
    permissions.history ? safe(() => chrome.history.search({ text: query, maxResults: 80, startTime: Date.now() - settings.historyDays * 86400000 }), 'history') : [],
    chrome.commands.getAll(),
  ]);
  return {
    settings, permissions, warnings, incognito: !!sender.tab?.incognito,
    overlayPosition: settings.rememberPos ? (await chrome.storage.session.get('overlayPosition')).overlayPosition : null,
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
  const { settings: saved } = await chrome.storage.local.get('settings');
  const settings = normalizeSettings(saved);
  const newTab = overlay || !!message.newTab || settings.openIn === 'new' || !sourceId;
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
    const url = searchUrl(query, settings);
    if (url) await navigate(url);
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

async function resetSettings() {
  resettingPermissions = true;
  autocomplete.cancelAll();
  try {
    // Disable opt-ins before revoking grants or announcing a settings change.
    const settings = { ...DEFAULT_SETTINGS };
    await chrome.storage.local.set({ settings });
    await chrome.storage.session.remove('overlayPosition');
    const optional = new Set(chrome.runtime.getManifest().optional_permissions || []);
    const optionalGrants = granted => ({
      permissions: (granted.permissions || []).filter(name => optional.has(name)),
      // Every declared HTTP(S) host grant is optional. Include narrower grants
      // made in the browser's site-access UI, not just our wildcard requests.
      origins: (granted.origins || []).filter(origin => /^https?:\/\//.test(origin)),
    });
    const granted = optionalGrants(await chrome.permissions.getAll());
    let failed = false;
    if (granted.permissions.length || granted.origins.length) {
      try { failed = !(await chrome.permissions.remove(granted)); }
      catch { failed = true; }
    }
    const remaining = optionalGrants(await chrome.permissions.getAll());
    if (failed || remaining.permissions.length || remaining.origins.length) {
      throw new Error('Settings were reset, but some permissions could not be removed. Check permissions at chrome://extensions, then try Restore defaults again.');
    }
    return { settings };
  } finally { resettingPermissions = false; }
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
    if (message.type === 'overlay-position') {
      if (new URL(sender.url).searchParams.get('mode') !== 'overlay') throw new Error('An overlay is required.');
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings?.rememberPos || message.position === null) { await chrome.storage.session.remove('overlayPosition'); return {}; }
      const p = message.position;
      if (!p || ![p.x, p.y].every(n => Number.isFinite(n) && n >= 0 && n <= 100000)) throw new Error('Invalid bar position.');
      await chrome.storage.session.set({ overlayPosition: { x: p.x, y: p.y } });
      return {};
    }
    if (message.type === 'settings' || message.type === 'reset-settings') {
      const save = settingsQueue.catch(() => {}).then(async () => {
        if (message.type === 'reset-settings') return resetSettings();
        const { settings: previous } = await chrome.storage.local.get('settings');
        const settings = normalizeSettings(previous);
        if (message.settings?.autocomplete === true && !(await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }))) throw new Error('Allow Google access before enabling query autocomplete.');
        if (message.settings?.newTabOverlay === true && !(await chrome.permissions.contains({ origins: OVERLAY_ORIGINS }))) throw new Error('Allow website access before enabling new tabs as an overlay.');
        Object.assign(settings, settingsPatch(message.settings));
        // Source toggles reflect real browser grants, not an editable flag.
        for (const name of ['bookmarks', 'history']) settings[name] = await chrome.permissions.contains({ permissions: [name] });
        if (!settings.rememberPos) await chrome.storage.session.remove('overlayPosition');
        await chrome.storage.local.set({ settings });
        return { settings };
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
