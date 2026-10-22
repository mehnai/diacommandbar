import { buildResults, parseQuery, DEFAULT_SETTINGS, autocompleteQuery, AUTOCOMPLETE_ORIGIN, OVERLAY_ORIGINS } from './core.js';

const paths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  tab: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  bookmark: '<path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4z"/>',
  history: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  settings: '<path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M12 12v5M9.5 14.5h5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.globe}</svg>`;
const $ = selector => document.querySelector(selector);
const query = $('#query');
const list = $('#results');
const dialog = $('#settings-dialog');
const params = new URLSearchParams(location.search);
const overlay = params.get('mode') === 'overlay';
const extension = !!globalThis.chrome?.runtime?.id;
const preview = !extension;
let state = { settings: { ...DEFAULT_SETTINGS }, permissions: { bookmarks: false, history: false }, tabs: [], bookmarks: [], history: [], shortcut: '' };
let filter = 'all';
let results = [];
let selected = 0;
let requestId = 0;
let debounce;
let busy = false;
let composing = false;
let suggestionTimer;
let suggestionEpoch = 0;
let suggestionKey = '';
let suggestions = [];
let suggestionNote = '';
const dark = matchMedia('(prefers-color-scheme: dark)');
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

document.body.classList.toggle('overlay', overlay);
if (overlay) {
  $('.palette').setAttribute('role', 'dialog');
  $('.palette').setAttribute('aria-modal', 'true');
}
$('.search-icon').innerHTML = icon('search');
$('#clear').innerHTML = icon('close');
$('#close-settings').innerHTML = icon('close');
$('.privacy-icon').innerHTML = icon('shield');
document.querySelectorAll('[data-settings]').forEach(button => { button.innerHTML = icon('settings') + (button.classList.contains('footer-settings') ? '<span>Customize</span>' : ''); });
if (!overlay) $('#dismiss').hidden = true;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension was reloaded. Refresh this page to reconnect.');
  return response.data;
}

function status(text, settings = false) { $(settings ? '#settings-status' : '#status').textContent = text; syncOverlayBounds(); }

function syncOverlayBounds() {
  if (!overlay || window.parent === window) return;
  const rect = (dialog.open ? dialog : $('.palette')).getBoundingClientRect();
  const note = !dialog.open && $('#status').textContent ? $('#status').getBoundingClientRect() : rect;
  // Geometry only: browser data and actions still use authenticated runtime
  // messages. The host validates the sending frame and extension origin.
  window.parent.postMessage({ type: 'dia-command-bar-layout', rect: [Math.min(rect.left, note.left), Math.min(rect.top, note.top), Math.max(rect.right, note.right), Math.max(rect.bottom, note.bottom)] }, '*');
}

function enableDragging() {
  const stage = $('.stage');
  const handle = $('#drag-handle');
  let drag;
  handle.hidden = false;
  const place = (x, y) => {
    const { width, height } = stage.getBoundingClientRect();
    stage.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    stage.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
    stage.style.transform = 'none';
    syncOverlayBounds();
  };
  const constrain = () => {
    const rect = stage.getBoundingClientRect();
    if (rect.left < 8 || rect.top < 8 || rect.right > innerWidth - 8 || rect.bottom > innerHeight - 8) place(rect.left, rect.top);
    syncOverlayBounds();
  };
  const center = () => {
    stage.style.left = stage.style.top = stage.style.transform = '';
    constrain();
  };
  const stop = () => {
    const pointerId = drag?.id;
    drag = null;
    document.body.classList.remove('dragging');
    if (pointerId !== undefined && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('dragging');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) place(event.clientX - drag.x, event.clientY - drag.y);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, stop);
  handle.addEventListener('dblclick', center);
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 40 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta && event.key !== 'Home') return;
    event.preventDefault();
    if (!delta) return center();
    const rect = stage.getBoundingClientRect();
    place(rect.left + delta[0], rect.top + delta[1]);
  });
  window.addEventListener('blur', stop);
  window.addEventListener('resize', constrain);
  // Results can grow after a drag; keep the footer and grip within reach.
  new ResizeObserver(constrain).observe(stage);
  new ResizeObserver(syncOverlayBounds).observe(dialog);
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data?.type === 'dia-command-bar-dismiss') {
      if (dialog.open) dialog.close();
      else dismiss();
    }
  });
  // Publish the first bounds synchronously: a fully clipped iframe may not
  // receive ResizeObserver callbacks until the browser starts painting it.
  constrain();
}

function applySettings() {
  const { theme, accent, engine } = state.settings;
  document.documentElement.dataset.theme = theme === 'system' ? (dark.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.accent = accent;
  $('#theme').value = theme;
  $('#engine').value = engine;
  document.querySelectorAll('[data-accent]').forEach(button => {
    if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.accent === accent));
  });
  for (const name of ['bookmarks', 'history']) $(`#enable-${name}`).checked = state.permissions[name];
  $('#enable-autocomplete').checked = state.settings.autocomplete === true && state.permissions.autocomplete === true;
  $('#enable-new-tab-overlay').checked = state.settings.newTabOverlay === true && state.permissions.newTabOverlay === true;
  if (state.incognito) {
    $('#enable-autocomplete').disabled = true;
    $('#autocomplete-description').textContent = 'Query autocomplete is paused in private browsing.';
  }
  if (!preview) $('#local-note').textContent = state.settings.autocomplete && state.permissions.autocomplete && !state.incognito ? 'Query suggestions by Google' : 'Yours, and only yours.';
  const shortcut = state.shortcut || (preview ? (mac ? '⌘ ⇧ L' : 'Ctrl ⇧ L') : 'Set shortcut');
  $('#shortcut-hint').replaceChildren(document.createTextNode(shortcut));
  const label = document.createElement('span'); label.textContent = 'from any page'; $('#shortcut-hint').append(label);
}

async function refresh() {
  const id = ++requestId;
  try {
    const parsed = parseQuery(query.value, filter);
    const next = preview ? previewSnapshot() : await send({ type: 'snapshot', query: parsed.query });
    if (id !== requestId) return;
    state = { ...state, ...next };
    applySettings();
    render();
    syncAutocomplete();
    if (next.warnings?.length) status(next.warnings.join(' '));
  } catch (error) { if (id === requestId) status(error.message); }
}

function syncAutocomplete() {
  const eligible = !preview && !busy && !composing && !dialog.open && !state.incognito && document.visibilityState !== 'hidden' && state.settings.autocomplete === true && state.permissions.autocomplete === true;
  const nextKey = eligible ? autocompleteQuery(query.value, filter) || '' : '';
  if (nextKey === suggestionKey) return;
  const epoch = ++suggestionEpoch;
  clearTimeout(suggestionTimer);
  if (suggestionKey && extension) send({ type: 'cancel-autocomplete' }).catch(() => {});
  suggestionKey = nextKey; suggestions = []; suggestionNote = nextKey ? 'Getting query suggestions…' : '';
  render();
  if (!nextKey) return;
  suggestionTimer = setTimeout(async () => {
    try {
      const response = await send({ type: 'autocomplete', input: nextKey, filter: 'all' });
      if (epoch !== suggestionEpoch) return;
      suggestions = response.suggestions;
      suggestionNote = response.unavailable ? 'Autocomplete is unavailable. You can still search.' : suggestions.length ? 'Query suggestions by Google' : '';
    } catch {
      if (epoch !== suggestionEpoch) return;
      suggestionNote = 'Autocomplete is unavailable. You can still search.';
    }
    render();
  }, 250);
}

function cancelAutocomplete() {
  ++suggestionEpoch; clearTimeout(suggestionTimer);
  if (suggestionKey && extension) send({ type: 'cancel-autocomplete' }).catch(() => {});
  suggestionKey = ''; suggestions = []; suggestionNote = '';
}

function render() {
  const previouslySelected = results[selected]?.id;
  const parsed = parseQuery(query.value, filter);
  results = buildResults({ input: query.value, filter, ...state, engine: state.settings.engine, suggestions });
  selected = Math.max(0, results.findIndex(result => result.id === previouslySelected));
  $('#clear').hidden = !query.value;
  document.querySelectorAll('[data-filter]').forEach(button => {
    const active = button.dataset.filter === parsed.filter;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  const headings = { all: parsed.query ? 'BEST MATCHES' : 'PICK UP WHERE YOU LEFT OFF', tabs: 'OPEN TABS', bookmarks: 'SAVED PLACES', history: 'RECENTLY VISITED', actions: 'BROWSER ACTIONS' };
  $('#result-heading').textContent = headings[parsed.filter];
  $('#result-count').textContent = results.length ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : '';
  $('#autocomplete-status').textContent = suggestionNote;
  $('#autocomplete-status').hidden = !suggestionNote;
  list.replaceChildren();
  results.forEach((result, index) => {
    const row = document.createElement('div'); row.className = 'result'; row.id = `result-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
    const symbol = document.createElement('span'); symbol.className = 'result-icon'; symbol.innerHTML = icon(result.icon);
    const copy = document.createElement('span'); copy.className = 'result-text';
    const title = document.createElement('span'); title.className = 'result-title'; title.textContent = result.title || result.url;
    const subtitle = document.createElement('span'); subtitle.className = 'result-subtitle'; subtitle.textContent = result.subtitle;
    copy.append(title, subtitle);
    const badge = document.createElement('span'); badge.className = 'result-kind'; badge.textContent = ({ tab: 'Switch to tab', bookmark: 'Bookmark', history: 'History', command: 'Action', search: 'Search', url: 'Website' })[result.kind];
    if (result.suggestion) badge.textContent = 'Suggestion';
    const arrow = document.createElement('span'); arrow.className = 'result-arrow'; arrow.textContent = '↵'; arrow.setAttribute('aria-hidden', 'true');
    row.append(symbol, copy, badge, arrow);
    row.addEventListener('pointermove', () => select(index, false));
    row.addEventListener('mousedown', event => event.preventDefault());
    row.addEventListener('click', event => activate(index, event.metaKey || event.ctrlKey));
    list.append(row);
  });
  const empty = $('#empty'); empty.hidden = results.length > 0; empty.replaceChildren();
  if (!results.length) {
    const locked = ['bookmarks', 'history'].includes(parsed.filter) && !state.permissions[parsed.filter];
    const heading = document.createElement('h3');
    const detail = document.createElement('p');
    const symbol = document.createElement('span'); symbol.innerHTML = icon(locked ? 'shield' : parsed.filter === 'tabs' ? 'tab' : 'search'); empty.append(symbol);
    if (locked) {
      heading.textContent = `Your ${parsed.filter}, one keystroke away.`;
      detail.textContent = `Allow ${parsed.filter} access to include them in your search. Everything is matched locally.`;
      const enable = document.createElement('button'); enable.className = 'secondary-button'; enable.textContent = `Enable ${parsed.filter}`;
      enable.addEventListener('click', () => setPermission(parsed.filter, true));
      empty.append(heading, detail, enable);
    } else {
      heading.textContent = parsed.query ? 'No matches here.' : parsed.filter === 'all' ? 'Every good detour starts somewhere.' : `No ${parsed.filter === 'tabs' ? 'other tabs open' : parsed.filter === 'history' ? 'recent history' : 'bookmarks yet'}.`;
      detail.textContent = parsed.query ? 'Try a different search, or choose Everything to search the web.' : 'Type a website, a thought, or > for browser actions.';
      empty.append(heading, detail);
    }
  }
  query.setAttribute('aria-expanded', String(results.length > 0));
  select(selected, false);
  syncOverlayBounds();
}

function select(index, scroll = true) {
  selected = Math.max(0, Math.min(index, results.length - 1));
  [...list.children].forEach((row, i) => { row.classList.toggle('selected', i === selected); row.setAttribute('aria-selected', String(i === selected)); });
  const active = list.children[selected];
  if (active) {
    query.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  } else query.removeAttribute('aria-activedescendant');
  $('#enter-hint').textContent = results[selected]?.kind === 'tab' ? 'to switch' : 'to open';
}

async function activate(index = selected, newTab = false) {
  if (busy || !results[index]) return;
  const item = results[index];
  if (item.kind === 'command' && item.id === 'settings') return openSettings();
  if (preview) { status(`Preview only · ${item.kind === 'tab' ? 'Switch to' : 'Open'} ${item.title}. Load the extension to use your real browser.`); return; }
  busy = true;
  cancelAutocomplete();
  try { await send({ type: 'execute', item, newTab }); status(''); }
  catch (error) { status(error.message); await refresh(); }
  finally { busy = false; }
}

function setFilter(next) {
  const parsed = parseQuery(query.value, filter); query.value = parsed.query; filter = next; selected = 0; results = [];
  syncAutocomplete(); render(); refresh(); query.focus();
}

async function dismiss() {
  cancelAutocomplete();
  if (overlay && extension) { try { await send({ type: 'dismiss' }); } catch (error) { status(error.message); } }
  else { query.value = ''; setFilter('all'); }
}

function openSettings() { status('', true); dialog.showModal(); syncAutocomplete(); syncOverlayBounds(); }
function closeSettings() { dialog.close(); query.focus(); syncOverlayBounds(); }

async function saveSettings(update) {
  const previous = { ...state.settings };
  state.settings = { ...state.settings, ...update }; applySettings(); render();
  try {
    if (preview) localStorage.setItem('dia-command-preview-settings', JSON.stringify(state.settings));
    else await send({ type: 'settings', settings: update });
    return true;
  } catch (error) { state.settings = previous; applySettings(); render(); status(error.message, true); return false; }
}

async function setAutocomplete(enabled) {
  const control = $('#enable-autocomplete');
  control.disabled = true;
  try {
    if (preview) { status('Load the extension to enable live query autocomplete.', true); return; }
    if (enabled) {
      // Request optional host access directly in the user's toggle gesture.
      const granted = await chrome.permissions.request({ origins: [AUTOCOMPLETE_ORIGIN] });
      if (!granted) { status('Google access was not granted. Query autocomplete remains off.', true); return; }
      state.permissions.autocomplete = true;
      if (await saveSettings({ autocomplete: true })) status('Query autocomplete enabled. Typed searches are sent to Google.', true);
    } else {
      cancelAutocomplete();
      if (!(await saveSettings({ autocomplete: false }))) return;
      // The optional all-websites grant also covers Google's host. Keep that
      // grant while new-tab overlays use it; the preference blocks requests.
      if (!state.settings.newTabOverlay) await chrome.permissions.remove({ origins: [AUTOCOMPLETE_ORIGIN] });
      status('Query autocomplete is off.', true);
    }
    await refresh();
  } catch (error) { status(error.message, true); }
  finally { control.disabled = !!state.incognito; applySettings(); syncAutocomplete(); }
}

async function setNewTabOverlay(enabled) {
  const control = $('#enable-new-tab-overlay');
  control.disabled = true;
  try {
    if (preview) { status('Load the extension to enable new tabs as an overlay.', true); return; }
    if (enabled) {
      const granted = await chrome.permissions.request({ origins: OVERLAY_ORIGINS });
      if (!granted) { status('Website access was not granted. New tabs will keep opening the command page.', true); return; }
      state.permissions.newTabOverlay = true;
      if (await saveSettings({ newTabOverlay: true })) status('New-tab overlay enabled. Return to a website, then press ⌘T / Ctrl+T.', true);
    } else {
      if (!(await saveSettings({ newTabOverlay: false }))) return;
      await chrome.permissions.remove({ origins: OVERLAY_ORIGINS });
      if (!state.settings.autocomplete) await chrome.permissions.remove({ origins: [AUTOCOMPLETE_ORIGIN] });
      // Chromium can fold a narrower Google grant into the broad grant. If
      // revoking it removes both, let the user renew Google access through the
      // autocomplete switch's own gesture.
      const renewAutocomplete = state.settings.autocomplete && !(await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }));
      if (renewAutocomplete) await saveSettings({ autocomplete: false });
      status(renewAutocomplete ? 'New-tab overlay is off. Enable Query autocomplete again to restore Google access.' : 'New-tab overlay is off. The extension shortcut still opens an overlay.', true);
    }
    await refresh();
  } catch (error) { status(error.message, true); }
  finally { control.disabled = false; applySettings(); }
}

async function setPermission(name, enabled) {
  try {
    if (preview) { status('Permission controls work when you load the extension in your browser.', true); status('Preview only · Load the extension to connect your browser data.'); return; }
    // Keep this call in the click/change event's user gesture, before any await.
    const accepted = enabled ? await chrome.permissions.request({ permissions: [name] }) : await chrome.permissions.remove({ permissions: [name] });
    status(enabled && !accepted ? 'Access was not granted. You can enable it whenever you’re ready.' : '', true);
    await refresh();
  } catch (error) { status(error.message, true); }
  finally { applySettings(); }
}

async function configureShortcut() {
  if (preview) { status('Load the extension, then configure its shortcut at chrome://extensions/shortcuts.', dialog.open); return; }
  try { await send({ type: 'execute', item: { kind: 'command', id: 'shortcuts' }, newTab: true }); }
  catch (error) { status(error.message, dialog.open); }
}

query.addEventListener('input', event => {
  composing = event.isComposing;
  ++requestId; clearTimeout(debounce); selected = 0; results = []; status(''); render();
  syncAutocomplete();
  debounce = setTimeout(refresh, 100);
});
query.addEventListener('compositionstart', () => { composing = true; syncAutocomplete(); });
query.addEventListener('compositionend', () => { composing = false; syncAutocomplete(); });
query.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); select(results.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0);
  } else if (event.key === 'Enter') { event.preventDefault(); activate(selected, event.metaKey || event.ctrlKey); }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || dialog.open) return;
  if (overlay && event.key === 'Tab') {
    const controls = [...document.querySelectorAll('.palette button:not([disabled]), .palette input')].filter(control => control.offsetParent !== null);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }
  if (event.key === 'Escape') { event.preventDefault(); if (query.value) { query.value = ''; setFilter('all'); } else dismiss(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings(); }
  if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key) && results[Number(event.key) - 1]) { event.preventDefault(); activate(Number(event.key) - 1); }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
document.querySelectorAll('[data-settings]').forEach(button => button.addEventListener('click', openSettings));
$('#clear').addEventListener('click', () => { query.value = ''; setFilter('all'); });
$('#dismiss').addEventListener('click', dismiss);
$('#close-settings').addEventListener('click', closeSettings);
dialog.addEventListener('close', () => { query.focus(); syncAutocomplete(); syncOverlayBounds(); });
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSettings(); } });
document.body.addEventListener('click', event => { if (overlay && !dialog.open && !event.target.closest('.palette, dialog, #status')) dismiss(); });
$('#theme').addEventListener('change', event => saveSettings({ theme: event.target.value }));
$('#engine').addEventListener('change', event => saveSettings({ engine: event.target.value }));
$('#enable-autocomplete').addEventListener('change', event => setAutocomplete(event.target.checked));
$('#enable-new-tab-overlay').addEventListener('change', event => setNewTabOverlay(event.target.checked));
document.querySelectorAll('button[data-accent]').forEach(button => button.addEventListener('click', () => saveSettings({ accent: button.dataset.accent })));
for (const name of ['bookmarks', 'history']) $(`#enable-${name}`).addEventListener('change', event => setPermission(name, event.target.checked));
$('#configure-shortcut').addEventListener('click', configureShortcut);
$('#shortcut-hint').addEventListener('click', configureShortcut);
dark.addEventListener('change', applySettings);
window.addEventListener('focus', () => { if (!dialog.open) { refresh(); if (overlay) query.focus(); } });
document.addEventListener('visibilitychange', syncAutocomplete);
window.addEventListener('pagehide', cancelAutocomplete);
if (extension) {
  if (!overlay && window.top === window.self) {
    chrome.tabs.getCurrent().then(tab => {
      if (!tab?.id) return;
      chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'focus-command-bar' || message.tabId !== tab.id) return;
        if (dialog.open) dialog.close();
        window.focus();
        query.focus({ preventScroll: true });
        respond({ focused: true });
      });
    }).catch(() => {});
  }
  chrome.permissions.onRemoved.addListener(() => { cancelAutocomplete(); render(); refresh(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { cancelAutocomplete(); render(); refresh(); }
  });
}

// The local preview is explicitly marked and never pretends these are real tabs.
function previewSnapshot() {
  let settings = { ...DEFAULT_SETTINGS };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem('dia-command-preview-settings') || '{}') }; } catch { /* Ignore invalid preview preferences. */ }
  return { settings, permissions: { bookmarks: false, history: false }, shortcut: mac ? '⌘ ⇧ L' : 'Ctrl ⇧ L', tabs: [
    { id: 1, title: 'A space for your next big idea', url: 'https://www.notion.so/' },
    { id: 2, title: 'Your work, in progress · GitHub', url: 'https://github.com/' },
    { id: 3, title: 'Design something wonderful · Figma', url: 'https://www.figma.com/' },
    { id: 4, title: 'A little inspiration · Are.na', url: 'https://www.are.na/' },
  ], bookmarks: [], history: [] };
}

if (window.top !== window.self && (!overlay || !params.get('token'))) {
  document.body.replaceChildren();
} else {
  if (preview) { $('#local-note').textContent = 'Design preview · sample tabs'; document.title = 'Command Bar · Design Preview'; }
  applySettings(); render();
  if (overlay) enableDragging();
  if (extension && overlay) send({ type: 'overlay-ready' }).catch(() => {});
  const initialize = async () => {
    if (extension && !overlay && !location.search && !location.hash) {
      // Run once per document, before accepting input. Refreshing data or
      // changing settings on an existing command page must never reroute it.
      busy = true; query.disabled = true;
      try {
        const result = await send({ type: 'route-new-tab' });
        if (result.reason) status(result.reason);
      } catch { /* The temporary tab may have closed after a successful handoff. */ }
      finally { busy = false; query.disabled = false; }
    }
    await refresh(); query.focus();
  };
  initialize();
}
