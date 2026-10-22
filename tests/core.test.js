import test from 'node:test';
import assert from 'node:assert/strict';
import { toNavigableUrl, buildResults, parseQuery, matchScore } from '../core.js';

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

test('ranks an already open exact URL before navigation and removes duplicate history', () => {
  const results = buildResults({ input: 'github.com', tabs: [{ id: 3, title: 'GitHub', url: 'https://github.com/' }], history: [{ id: 5, title: 'GitHub', url: 'https://github.com/' }] });
  assert.deepEqual(results.map(r => r.kind), ['tab', 'url']);
  assert.equal(results[0].tabId, 3);
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
