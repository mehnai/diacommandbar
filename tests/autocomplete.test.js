import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutocompleteService } from '../autocomplete.js';
import { autocompleteQuery, normalizeSuggestions, buildResults, DEFAULT_SETTINGS } from '../core.js';

test('autocomplete defaults off and only accepts ordinary search queries', () => {
  assert.equal(DEFAULT_SETTINGS.autocomplete, false);
  assert.equal(autocompleteQuery(' weather tom '), 'weather tom');
  for (const value of ['', 'hi', 'https://example.com/private', 'example.com', 'localhost:3000', 'me@example.com', '@work', '*work', '#work', '>downloads', 'line\nbreak', 'a'.repeat(201)]) assert.equal(autocompleteQuery(value), null, value);
  assert.equal(autocompleteQuery('weather', 'tabs'), null);
});

test('provider data is bounded and deduplicated; completions stay search actions', () => {
  assert.deepEqual(normalizeSuggestions(['weather', ['weather', 'Weather tomorrow', 'weather tomorrow', null, '', 'bad\nline', 'a'.repeat(201)]], 'weather'), ['Weather tomorrow']);
  assert.deepEqual(normalizeSuggestions({ results: [] }, 'weather'), []);
  const results = buildResults({ input: 'weather', engine: 'bing', suggestions: ['weather tomorrow', 'weather.com'] });
  assert.equal(results[0].id, 'search');
  assert.equal(results[1].query, 'weather tomorrow');
  assert.equal(results[0].subtitle, 'with Bing');
  assert.equal(results[1].subtitle, '');
  assert.equal(results[2].kind, 'search');
  assert.deepEqual(buildResults({ input: '@weather', suggestions: ['weather tomorrow'] }), []);
});

test('no network requests without consent, for source queries, or in private browsing', async () => {
  let calls = 0;
  const service = createAutocompleteService({ isAllowed: async () => false, fetchImpl: async () => { calls++; } });
  assert.deepEqual(await service.request({ client: 'a', input: 'weather' }), { suggestions: [] });
  const allowed = createAutocompleteService({ isAllowed: async () => true, fetchImpl: async () => { calls++; } });
  for (const options of [{ input: 'weather', incognito: true }, { input: '>weather' }, { input: 'https://example.com/' }]) await allowed.request({ client: 'a', ...options });
  assert.equal(calls, 0);
});

test('requests omit credentials, referrers, redirects, and cache', async () => {
  let captured;
  const service = createAutocompleteService({ isAllowed: async () => true, fetchImpl: async (url, options) => {
    captured = { url, options }; return { ok: true, json: async () => ['weather', ['weather tomorrow']] };
  } });
  assert.deepEqual(await service.request({ client: 'a', input: 'weather' }), { suggestions: ['weather tomorrow'] });
  assert.equal(new URL(captured.url).hostname, 'suggestqueries.google.com');
  assert.equal(new URL(captured.url).pathname, '/complete/search');
  assert.equal(new URL(captured.url).searchParams.get('client'), 'chrome');
  assert.equal(new URL(captured.url).searchParams.get('oe'), 'UTF-8');
  assert.equal(new URL(captured.url).searchParams.get('q'), 'weather');
  for (const [key, value] of Object.entries({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' })) assert.equal(captured.options[key], value);
});

test('new input cancels stale requests; cancelAll aborts requests across documents', async () => {
  const active = [];
  const service = createAutocompleteService({ isAllowed: async () => true, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    active.push(signal); signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }) });
  const first = service.request({ client: 'a', input: 'weather' });
  await new Promise(resolve => setImmediate(resolve));
  const second = service.request({ client: 'a', input: 'weather tomorrow' });
  const third = service.request({ client: 'b', input: 'weather tonight' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active[0].aborted, true);
  service.cancelAll();
  await Promise.all([first, second, third]);
  assert.ok(active.every(signal => signal.aborted));
});

test('network errors, malformed data and timeouts preserve normal searching', async () => {
  for (const fetchImpl of [async () => { throw new Error('Offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ invalid: true }) }), (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Timed out'))))]) {
    const service = createAutocompleteService({ isAllowed: async () => true, fetchImpl, timeoutMs: 10 });
    assert.deepEqual(await service.request({ client: 'a', input: 'weather' }), { suggestions: [], unavailable: true });
  }
});
