export const DEFAULT_SETTINGS = Object.freeze({ theme: 'system', accent: 'lilac', engine: 'default', autocomplete: false, newTabOverlay: false });
export const AUTOCOMPLETE_ORIGIN = 'https://suggestqueries.google.com/*';
export const OVERLAY_ORIGINS = ['http://*/*', 'https://*/*'];
export const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=' },
};
export const COMMANDS = [
  { id: 'new-window', title: 'New window', subtitle: 'A fresh place to start', icon: 'window', keywords: 'create browser' },
  { id: 'downloads', title: 'Open downloads', subtitle: 'Find your downloaded files', icon: 'download', keywords: 'files' },
  { id: 'bookmarks', title: 'Open bookmark manager', subtitle: 'All your saved places', icon: 'bookmark', keywords: 'saved favorites' },
  { id: 'history', title: 'Open browser history', subtitle: 'Retrace your steps', icon: 'history', keywords: 'recent visited' },
  { id: 'extensions', title: 'Manage extensions', subtitle: 'Your browser, your way', icon: 'grid', keywords: 'plugins addons' },
  { id: 'shortcuts', title: 'Configure keyboard shortcut', subtitle: 'Choose how you open the command bar', icon: 'keyboard', keywords: 'hotkey keys' },
  { id: 'settings', title: 'Customize command bar', subtitle: 'Appearance, search, and sources', icon: 'settings', keywords: 'preferences theme dark light' },
];

// Deliberately reject executable protocols, credentials, and ambiguous prose.
export function toNavigableUrl(input) {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  let candidate = value;
  if (/^https?:\/\//i.test(value)) {
    candidate = value;
  } else if (/^(chrome|dia|arc):\/\//i.test(value)) {
    try { const url = new URL(value); return url.hostname ? url.href : null; } catch { return null; }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(value)) return null;
    const authority = value.split(/[/?#]/)[0];
    const host = authority.replace(/:\d+$/, '');
    if (!(host === 'localhost' || host.endsWith('.localhost') || /^\[[\da-f:]+\]$/i.test(host) || /^(?:[^.\s:@]+\.)+[^.\s:@]{2,}$/u.test(host) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host))) return null;
    candidate = `${host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' ? 'http' : 'https'}://${value}`;
  }
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function displayUrl(value = '') {
  try { const u = new URL(value); return `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`; }
  catch { return value; }
}

export function canonicalUrl(value) {
  try { const u = new URL(value); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return value; }
}

export function parseQuery(value, filter = 'all') {
  const prefixes = { '>': 'actions', '@': 'tabs', '*': 'bookmarks', '#': 'history' };
  const trimmed = value.trimStart();
  return prefixes[trimmed[0]] ? { filter: prefixes[trimmed[0]], query: trimmed.slice(1).trim() } : { filter, query: trimmed.trim() };
}

export function matchScore(item, query) {
  if (!query) return 1;
  const title = (item.title || '').toLowerCase();
  const haystack = `${title} ${item.url || ''} ${item.keywords || ''}`.toLowerCase();
  const needle = query.toLowerCase();
  const tokens = needle.split(/\s+/);
  if (tokens.every(token => haystack.includes(token))) {
    return 100 + (title === needle ? 100 : 0) + (title.startsWith(needle) ? 50 : 0) + (title.includes(needle) ? 20 : 0);
  }
  // Allow a short, ordered abbreviation such as "gh" or "gcal".
  if (tokens.length !== 1 || needle.length > 12) return 0;
  let at = 0;
  for (const char of haystack) if (char === needle[at]) at++;
  return at === needle.length ? 10 : 0;
}

export function autocompleteQuery(input, filter = 'all') {
  const parsed = parseQuery(String(input || ''), filter);
  const query = parsed.query;
  // Avoid sending address-like input, source-scoped queries, and long pasted text.
  if (parsed.filter !== 'all' || query.length < 3 || query.length > 200 || toNavigableUrl(query) || /[\/@\\\r\n]/.test(query) || /^[a-z][a-z\d+.-]*:/i.test(query)) return null;
  return query;
}

export function normalizeSuggestions(payload, query) {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];
  const seen = new Set([query.toLocaleLowerCase()]);
  return payload[1].filter(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    const key = value.trim().toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 5).map(value => value.trim());
}

export function buildResults({ input = '', filter = 'all', tabs = [], bookmarks = [], history = [], engine = 'default', suggestions = [] }) {
  const parsed = parseQuery(input, filter);
  const { query } = parsed;
  const scope = parsed.filter;
  if (scope === 'actions') return COMMANDS.map(c => ({ ...c, kind: 'command' })).filter(c => matchScore(c, query)).sort((a, b) => matchScore(b, query) - matchScore(a, query));
  const sources = [];
  if (scope === 'all' || scope === 'tabs') sources.push(...tabs.map(t => ({ ...t, kind: 'tab', icon: 'tab', subtitle: displayUrl(t.url), tabId: t.id, id: `tab-${t.id}` })));
  if (scope === 'all' || scope === 'bookmarks') sources.push(...bookmarks.map(b => ({ ...b, kind: 'bookmark', icon: 'bookmark', subtitle: displayUrl(b.url), id: `bookmark-${b.id}` })));
  if (scope === 'all' || scope === 'history') sources.push(...history.map(h => ({ ...h, kind: 'history', icon: 'history', subtitle: displayUrl(h.url), id: `history-${h.id}` })));
  const seen = new Set();
  const ranked = sources.filter(item => {
    if (!toNavigableUrl(item.url || '') || !matchScore(item, query)) return false;
    const key = canonicalUrl(item.url);
    // Preserve duplicate open tabs; don't repeat them again as history/bookmarks.
    if (item.kind !== 'tab' && seen.has(key)) return false;
    seen.add(key); return true;
  }).map((item, index) => ({ ...item, score: matchScore(item, query) + (item.kind === 'tab' ? 30 : item.kind === 'bookmark' ? 10 : 0), order: index }))
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, query ? 8 : 6);
  if (scope === 'all' && query) {
    const url = toNavigableUrl(query);
    const direct = url ? { id: 'navigate', kind: 'url', icon: 'globe', title: query, subtitle: 'Go to website', url }
      : { id: 'search', kind: 'search', icon: 'search', title: query, subtitle: `Search ${ENGINES[engine]?.name || 'your default search engine'}`, query };
    const exactTab = url && ranked.findIndex(r => r.kind === 'tab' && canonicalUrl(r.url) === canonicalUrl(url));
    if (typeof exactTab === 'number' && exactTab >= 0) {
      const [tab] = ranked.splice(exactTab, 1); ranked.unshift(tab); ranked.splice(1, 0, direct);
    } else ranked.unshift(direct);
    if (autocompleteQuery(input, filter)) {
      ranked.push(...normalizeSuggestions([query, suggestions], query).map(text => ({
        id: `suggestion-${text}`, kind: 'search', suggestion: true, icon: 'search', title: text,
        subtitle: `Search ${ENGINES[engine]?.name || 'your default search engine'}`, query: text,
      })));
    }
  }
  return ranked;
}
