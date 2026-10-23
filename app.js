import { buildResults, parseQuery, DEFAULT_SETTINGS, normalizeSettings, autocompleteQuery, AUTOCOMPLETE_ORIGIN, OVERLAY_ORIGINS } from './core.js';
import { createSettingsUI } from './settings-ui.js';

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
let filter = DEFAULT_SETTINGS.defaultScope;
let settingsLoaded = false;
let restoreOverlayPosition = () => {};
let persistOverlayPosition = () => {};
let recenterOverlay = () => {};
const statusTimers = {};
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
$('#dismiss').hidden = !overlay;
document.querySelectorAll('[data-modifier]').forEach(key => { key.textContent = (mac ? '⌘' : 'Ctrl') + key.dataset.modifier; });
const settingsUI = createSettingsUI({ dialog, onChange: changeSetting, onReset: restoreDefaults, onShortcut: configureShortcut, clearStatus: () => status('', true), modifier: mac ? '⌘' : 'Ctrl' });

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension was reloaded. Refresh this page to reconnect.');
  return response.data;
}

function status(text, settings = false) {
  const id = settings ? '#settings-status' : '#status';
  clearTimeout(statusTimers[id]); $(id).textContent = text; syncOverlayBounds();
  if (text) statusTimers[id] = setTimeout(() => { $(id).textContent = ''; syncOverlayBounds(); }, 2800);
}

function syncOverlayBounds() {
  if (!overlay || window.parent === window) return;
  const rect = (dialog.open ? dialog : $('.palette')).getBoundingClientRect();
  const note = !dialog.open && $('#status').textContent ? $('#status').getBoundingClientRect() : rect;
  // Geometry only: browser data and actions still use authenticated runtime
  // messages. The host validates the sending frame and extension origin.
  window.parent.postMessage({ type: 'dia-command-bar-layout', radius: dialog.open ? state.settings.radius + 4 : state.settings.radius, rect: [Math.min(rect.left, note.left), Math.min(rect.top, note.top), Math.max(rect.right, note.right), Math.max(rect.bottom, note.bottom)] }, '*');
}

function enableDragging() {
  const stage = $('.stage');
  const handle = $('#drag-handle');
  let drag;
  let restored = false;
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
  persistOverlayPosition = () => {
    if (!state.settings.rememberPos) return;
    const rect = stage.getBoundingClientRect();
    const position = stage.style.left ? { x: rect.left, y: rect.top } : null;
    if (extension) send({ type: 'overlay-position', position }).catch(() => {});
    else if (position) sessionStorage.setItem('dia-preview-position', JSON.stringify(position));
    else sessionStorage.removeItem('dia-preview-position');
  };
  restoreOverlayPosition = position => {
    if (restored) return;
    restored = true;
    if (state.settings.rememberPos && position && [position.x, position.y].every(Number.isFinite)) place(position.x, position.y);
    else constrain();
  };
  const center = () => {
    stage.style.left = stage.style.top = stage.style.transform = '';
    constrain(); persistOverlayPosition();
  };
  recenterOverlay = center;
  const stop = () => {
    const pointerId = drag?.id;
    drag = null;
    document.body.classList.remove('dragging');
    if (pointerId !== undefined) {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      persistOverlayPosition();
    }
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
    place(rect.left + delta[0], rect.top + delta[1]); persistOverlayPosition();
  });
  window.addEventListener('blur', stop);
  window.addEventListener('resize', constrain);
  // Results can grow after a drag; keep the footer and grip within reach.
  new ResizeObserver(constrain).observe(stage);
  new ResizeObserver(syncOverlayBounds).observe(dialog);
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data?.type === 'dia-command-bar-dismiss') {
      if (dialog.open) dialog.close();
      else if (state.settings.outsideDismiss) dismiss();
    }
  });
  // Publish the first bounds synchronously: a fully clipped iframe may not
  // receive ResizeObserver callbacks until the browser starts painting it.
  constrain();
}

function updateClock() {
  if (overlay || !state.settings.clock) return;
  const now = new Date();
  $('#time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: state.settings.hour12 });
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function applySettings() {
  const s = state.settings, root = document.documentElement;
  const theme = s.theme === 'system' ? (dark.matches ? 'dark' : 'light') : s.theme;
  Object.assign(root.dataset, { theme, accent: s.accent, contrast: s.contrast, selection: s.selection });
  Object.assign(document.body.dataset, { clock: String(s.clock), position: s.position, background: s.background });
  const hue = { blue: 255, green: 150, orange: 55, red: 25 }[s.accent];
  const density = { compact: [6, 11], default: [8, 14], roomy: [11, 18] }[s.density];
  const font = { dia: 'var(--ui)', serif: 'var(--display)', mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace' }[s.font];
  for (const [key, value] of Object.entries({ accent: hue === undefined ? 'var(--ink)' : `oklch(${theme === 'dark' ? .72 : .55} 0.15 ${hue})`, r: `${s.radius}px`, 'bar-w': `${s.width}px`, 'row-py': `${density[0]}px`, 'pad-y': `${density[1]}px`, font })) root.style.setProperty(`--${key}`, value);
  $('.clock').hidden = overlay || !s.clock;
  $('.filter-row').hidden = !s.chips;
  $('.palette-footer').hidden = !s.hints;
  settingsUI.update(state);
  updateClock(); syncOverlayBounds();
}

async function refresh() {
  const id = ++requestId;
  try {
    const parsed = parseQuery(query.value, filter);
    const next = preview ? previewSnapshot() : await send({ type: 'snapshot', query: parsed.query });
    if (id !== requestId) return;
    const oldScope = state.settings.defaultScope;
    state = { ...state, ...next };
    state.settings = normalizeSettings(state.settings);
    if (!settingsLoaded || oldScope !== state.settings.defaultScope) filter = state.settings.defaultScope;
    settingsLoaded = true;
    applySettings();
    restoreOverlayPosition(next.overlayPosition);
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
      suggestionNote = response.unavailable ? 'Autocomplete is unavailable. You can still search.' : suggestions.length ? 'Suggestions from Google' : '';
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
    const number = document.createElement('span'); number.className = 'result-number'; number.textContent = index < 9 ? `${mac ? '⌘' : 'Ctrl+'}${index + 1}` : ''; number.setAttribute('aria-hidden', 'true');
    symbol.hidden = !state.settings.icons; badge.hidden = !state.settings.kinds; number.hidden = !state.settings.numbers;
    row.append(symbol, copy, badge, number);
    row.addEventListener('pointermove', () => select(index, false));
    row.addEventListener('mousedown', event => event.preventDefault());
    row.addEventListener('click', event => activate(index, event.metaKey || event.ctrlKey));
    list.append(row);
  });
  const empty = $('#empty'); empty.hidden = results.length > 0; empty.replaceChildren();
  if (!results.length) {
    const locked = ['bookmarks', 'history'].includes(parsed.filter) && !state.permissions[parsed.filter];
    const heading = document.createElement('span');
    const detail = document.createElement('span'); detail.className = 'empty-detail';
    if (locked) {
      heading.textContent = `Searching ${parsed.filter} is off.`;
      detail.textContent = 'Turn it on and they’ll show up here.';
      const enable = document.createElement('button'); enable.className = 'text-link'; enable.textContent = 'Turn on';
      enable.addEventListener('click', () => setPermission(parsed.filter, true));
      empty.append(heading, detail, enable);
    } else {
      heading.textContent = parsed.query ? 'Nothing matches.' : 'Nothing here yet.';
      detail.textContent = parsed.query ? (parsed.filter === 'all' ? '' : 'Try Everything to search the web.') : 'Type a site, a search, or > for actions.';
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
  $('#enter-hint').textContent = results[selected]?.kind === 'tab' ? 'Switch' : 'Open';
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
  if (overlay && extension) {
    try {
      await send({ type: 'dismiss' });
      // Closing existing UI needs no new website access after a reset.
      window.parent.postMessage({ type: 'dia-command-bar-close' }, '*');
    } catch (error) { status(error.message); }
  }
  else { query.value = ''; setFilter(state.settings.defaultScope); }
}

function openSettings() { if (dialog.open) return; status('', true); settingsUI.update(state); dialog.showModal(); syncAutocomplete(); syncOverlayBounds(); }
function closeSettings() { dialog.close(); query.focus(); syncOverlayBounds(); }

async function saveSettings(update) {
  const previous = { ...state.settings };
  state.settings = normalizeSettings({ ...state.settings, ...update });
  if (update.defaultScope) filter = update.defaultScope;
  applySettings(); render();
  try {
    if (preview) localStorage.setItem('dia-command-preview-settings', JSON.stringify(state.settings));
    else await send({ type: 'settings', settings: update });
    return true;
  } catch (error) { state.settings = previous; applySettings(); render(); status(error.message, true); return false; }
}

async function setAutocomplete(enabled) {
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
  finally { applySettings(); syncAutocomplete(); }
}

async function setNewTabOverlay(enabled) {
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
      // autocomplete control’s own gesture.
      const renewAutocomplete = state.settings.autocomplete && !(await chrome.permissions.contains({ origins: [AUTOCOMPLETE_ORIGIN] }));
      if (renewAutocomplete) await saveSettings({ autocomplete: false });
      status(renewAutocomplete ? 'New-tab overlay is off. Enable search suggestions again to restore Google access.' : 'New-tab overlay is off. The extension shortcut still opens an overlay.', true);
    }
    await refresh();
  } catch (error) { status(error.message, true); }
  finally { applySettings(); }
}

async function setPermission(name, enabled) {
  try {
    if (preview) { status('Permission controls work when you load the extension in your browser.', true); status('Preview only · Load the extension to connect your browser data.'); return; }
    // Keep this call in the click/change event's user gesture, before any await.
    const accepted = enabled ? await chrome.permissions.request({ permissions: [name] }) : await chrome.permissions.remove({ permissions: [name] });
    await refresh();
    status(enabled && !accepted ? 'Access was not granted. You can enable it whenever you’re ready.' : enabled ? `Done — the bar can now search your ${name}.` : `Turned off. The bar no longer sees your ${name}.`, dialog.open);
  } catch (error) { status(error.message, true); }
  finally { applySettings(); }
}

function changeSetting(key, value) {
  if (key === 'autocomplete') return setAutocomplete(value);
  if (key === 'newTabOverlay') return setNewTabOverlay(value);
  if (['bookmarks', 'history'].includes(key)) return setPermission(key, value);
  return saveSettings({ [key]: value }).then(async saved => {
    if (!saved) return;
    if (key === 'rememberPos' && value) persistOverlayPosition();
    if (key === 'rememberPos' && !value && preview) sessionStorage.removeItem('dia-preview-position');
    await refresh();
  });
}

async function restoreDefaults() {
  cancelAutocomplete();
  try {
    if (preview) {
      localStorage.setItem('dia-command-preview-settings', JSON.stringify(DEFAULT_SETTINGS));
      sessionStorage.removeItem('dia-preview-position');
    } else await send({ type: 'reset-settings' });
    await refresh(); filter = state.settings.defaultScope; render(); recenterOverlay();
    status(preview ? 'Back to the defaults.' : 'Back to the defaults. Optional permissions removed.', true);
  } catch (error) { await refresh(); status(error.message, true); }
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
  if (event.isComposing || composing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); select(results.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0);
  } else if (event.key === 'Enter') { event.preventDefault(); activate(selected, event.metaKey || event.ctrlKey); }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || composing || dialog.open) return;
  if (overlay && event.key === 'Tab') {
    const controls = [...document.querySelectorAll('.palette button:not([disabled]), .palette input')].filter(control => control.offsetParent !== null);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }
  if (event.key === 'Escape') { event.preventDefault(); if (query.value || filter !== state.settings.defaultScope) { query.value = ''; setFilter(state.settings.defaultScope); } else dismiss(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings(); }
  if ((event.metaKey || event.ctrlKey) && document.activeElement === query && /^[1-9]$/.test(event.key) && results[Number(event.key) - 1]) { event.preventDefault(); activate(Number(event.key) - 1); }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
document.querySelectorAll('[data-settings]').forEach(button => button.addEventListener('click', openSettings));
$('#clear').addEventListener('click', () => { query.value = ''; setFilter(state.settings.defaultScope); });
$('#dismiss').addEventListener('click', dismiss);
$('#close-settings').addEventListener('click', closeSettings);
dialog.addEventListener('close', () => { query.focus(); syncAutocomplete(); syncOverlayBounds(); });
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSettings(); } });
document.body.addEventListener('click', event => { if (overlay && state.settings.outsideDismiss && !dialog.open && !event.target.closest('.palette, dialog, #status')) dismiss(); });
dark.addEventListener('change', applySettings);
if (!overlay) setInterval(updateClock, 10000);
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

// Sample data is confined to the local preview; the extension only uses browser data.
function previewSnapshot() {
  let settings = { ...DEFAULT_SETTINGS };
  try { settings = normalizeSettings(JSON.parse(localStorage.getItem('dia-command-preview-settings') || '{}')); } catch { /* Ignore invalid preview preferences. */ }
  let overlayPosition = null;
  try { overlayPosition = JSON.parse(sessionStorage.getItem('dia-preview-position')); } catch {}
  return { settings, overlayPosition, permissions: { bookmarks: false, history: false }, shortcut: mac ? '⌘ ⇧ L' : 'Ctrl ⇧ L', tabs: [
    { id: 1, windowId: 1, title: 'A space for your next big idea', url: 'https://www.notion.so/' },
    { id: 2, windowId: 1, title: 'Your work, in progress · GitHub', url: 'https://github.com/' },
    { id: 3, windowId: 2, title: 'Design something wonderful · Figma', url: 'https://www.figma.com/' },
    { id: 4, windowId: 2, title: 'A little inspiration · Are.na', url: 'https://www.are.na/' },
  ].filter(tab => settings.allWindows || tab.windowId === 1), bookmarks: [], history: [] };
}

if (window.top !== window.self && (!overlay || !params.get('token'))) {
  document.body.replaceChildren();
} else {
  if (preview) document.title = 'Command Bar · Design Preview';
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
