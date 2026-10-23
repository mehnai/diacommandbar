import test from 'node:test';
import assert from 'node:assert/strict';
import { toNavigableUrl, buildResults, parseQuery, matchScore, normalizeSettings, settingsPatch, DEFAULT_SETTINGS, validCustomUrl, searchUrl } from '../core.js';

test('recognizes URLs, local development addresses, Unicode hosts and IPs', () => {
  for (const [input, expected] of [
    ['example.com', 'https://example.com/'], ['https://example.com/a?q=hi', 'https://example.com/a?q=hi'],
    ['localhost:3000', 'http://localhost:3000/'], ['127.0.0.1:8080/path', 'http://127.0.0.1:8080/path'],
    ['[::1]:3000', 'http://[::1]:3000/'], ['192.168.1.2', 'https://192.168.1.2/'],
    ['café.fr', 'https://xn--caf-dma.fr/'], ['chrome://downloads', 'chrome://downloads'],
  ]) assert.equal(toNavigableUrl(input), expected, input);
});

test('keeps prose as searches and rejects unsafe or malformed URLs', () => {
  for (const input of ['', 'hello world', 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://user:pass@example.com', 'example.com@evil.com', '999.999.999.999', 'http://', 'https://example.com has a space', 'localhost:abc']) assert.equal(toNavigableUrl(input), null, input);
});

test('parses each source shortcut without changing the entered text', () => {
  assert.deepEqual(parseQuery(' @ github ', 'all'), { filter: 'tabs', query: 'github' });
  assert.deepEqual(parseQuery('> downloads'), { filter: 'actions', query: 'downloads' });
  assert.deepEqual(parseQuery('*design'), { filter: 'bookmarks', query: 'design' });
  assert.deepEqual(parseQuery('#yesterday'), { filter: 'history', query: 'yesterday' });
  assert.deepEqual(parseQuery('work', 'tabs'), { filter: 'tabs', query: 'work' });
});

test('puts the website action first while retaining the matching tab and deduplicating history', () => {
  const results = buildResults({ input: 'github.com', tabs: [{ id: 3, title: 'GitHub', url: 'https://github.com/' }], history: [{ id: 5, title: 'GitHub', url: 'https://github.com/' }] });
  assert.deepEqual(results.map(r => r.kind), ['url', 'tab']);
  assert.equal(results[1].tabId, 3);
});

test('keeps duplicate tabs distinct so either can be selected', () => {
  const results = buildResults({ tabs: [{ id: 3, title: 'A', url: 'https://example.com/' }, { id: 4, title: 'B', url: 'https://example.com/' }] });
  assert.deepEqual(results.map(r => r.tabId), [3, 4]);
});

test('search has an explicit action, while source scopes never silently search the web', () => {
  assert.equal(buildResults({ input: 'a long thought' })[0].kind, 'search');
  assert.deepEqual(buildResults({ input: '@ a long thought' }), []);
  assert.equal(buildResults({ input: '> downloads' })[0].id, 'downloads');
});

test('ranks multiword matches and ordered abbreviations', () => {
  assert.ok(matchScore({ title: 'Google Calendar' }, 'gcal') > 0);
  assert.ok(matchScore({ title: 'Project status', url: 'https://notion.so/' }, 'project notion') > 0);
  assert.equal(matchScore({ title: 'Project status' }, 'zzxy'), 0);
});

test('settings migrate legacy accents, preserve preferences, and reject malformed patches', () => {
  for (const accent of ['lilac', 'sage', 'rose', 'sand']) {
    const s = normalizeSettings({ accent, theme: 'dark', engine: 'google', autocomplete: true, newTabOverlay: true });
    assert.equal(s.accent, 'mono');
    assert.equal(s.theme, 'dark'); assert.equal(s.engine, 'google');
    assert.equal(s.autocomplete, true); assert.equal(s.newTabOverlay, true);
    assert.equal(s.clock, true); assert.equal(s.width, 620);
  }
  assert.deepEqual(settingsPatch({ radius: 13, width: 9999, historyDays: -1, maxResults: '10', outsideDismiss: 'false', font: 'remote', theme: 'url(evil)', unknown: true }), {});
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ openIn: 'current' }).openIn, 'auto');
  assert.equal(normalizeSettings({ openIn: 'replace' }).openIn, 'replace');
  assert.equal(normalizeSettings({ newTabPage: false }).newTabPage, false);
});

test('custom searches validate the template and encode words without allowing executable URLs', () => {
  for (const url of ['javascript:%s', 'file:///%s', 'http://example.com/?q=%s', 'http://localhost:3000/?q=%s', 'https://example.com/no-placeholder', 'https://user:pass@example.com/?q=%s']) assert.equal(validCustomUrl(url), false);
  const settings = { engine: 'custom', customUrl: 'https://example.com/search?q=%s&also=%s' };
  assert.equal(searchUrl('a & café#', settings), 'https://example.com/search?q=a%20%26%20caf%C3%A9%23&also=a%20%26%20caf%C3%A9%23');
  assert.throws(() => searchUrl('words', { engine: 'custom', customUrl: '' }), /valid HTTPS search address/);
  assert.equal(searchUrl('words', { engine: 'default' }), null);
  const legacy = { engine: 'custom', customUrl: 'http://example.com/?q=%s' };
  assert.equal(normalizeSettings(legacy).customUrl, '');
  assert.deepEqual(settingsPatch({ customUrl: legacy.customUrl }), {});
  assert.throws(() => searchUrl('private words', legacy), /HTTPS/);
});

test('result limits bound the complete list, including searches, suggestions, and actions', () => {
  const tabs = Array.from({ length: 12 }, (_, id) => ({ id, title: `Work ${id}`, url: `https://example.com/${id}` }));
  const results = buildResults({ input: 'work', tabs, settings: { maxResults: 3 }, suggestions: ['work ideas', 'work today'] });
  assert.equal(results.length, 3);
  assert.equal(results.filter(r => r.kind === 'tab').length, 2);
  assert.equal(results[0].id, 'search');
  assert.equal(buildResults({ input: 'work', settings: { maxResults: 3 }, suggestions: ['work ideas', 'work today', 'work tomorrow'] }).length, 3);
  assert.equal(buildResults({ input: '>', settings: { maxResults: 3 } }).length, 3);
  assert.equal(buildResults({ input: '@work', tabs, settings: { maxResults: 10 } }).length, 10);
});
