import { autocompleteQuery, normalizeSuggestions } from './core.js';

// No query cache or persistent query storage. One in-flight request per document.
export function createAutocompleteService({ isAllowed, fetchImpl = fetch, timeoutMs = 2500 }) {
  const pending = new Map();
  const cancel = client => { pending.get(client)?.abort(); pending.delete(client); };
  const cancelAll = () => { for (const client of pending.keys()) cancel(client); };
  async function request({ client, input, filter, incognito = false }) {
    cancel(client);
    const query = autocompleteQuery(input, filter);
    if (!query || incognito) return { suggestions: [] };
    const controller = new AbortController();
    pending.set(client, controller);
    let timer;
    try {
      if (!(await isAllowed()) || controller.signal.aborted) return { suggestions: [] };
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = new URL('https://suggestqueries.google.com/complete/search');
      url.searchParams.set('q', query); url.searchParams.set('client', 'chrome');
      url.searchParams.set('ie', 'UTF-8'); url.searchParams.set('oe', 'UTF-8');
      const response = await fetchImpl(url.href, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) throw new Error('Autocomplete unavailable');
      const payload = await response.json();
      if (controller.signal.aborted) return { suggestions: [] };
      if (!Array.isArray(payload) || !Array.isArray(payload[1])) throw new Error('Invalid autocomplete response');
      return { suggestions: normalizeSuggestions(payload, query) };
    } catch {
      return { suggestions: [], unavailable: true };
    } finally {
      clearTimeout(timer);
      if (pending.get(client) === controller) pending.delete(client);
    }
  }
  return { request, cancel, cancelAll };
}
