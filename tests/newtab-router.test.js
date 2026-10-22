import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewTabRouter } from '../newtab-router.js';

const pageUrl = 'chrome-extension://test/newtab.html';
const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
};
const storage = data => ({
  get: async key => ({ [key]: data[key] }),
  set: async values => Object.assign(data, values),
  remove: async key => { delete data[key]; },
});

async function setup({ permission = true, enabled = true, ready = true, duringOpen = () => {} } = {}) {
  const source = { id: 1, windowId: 10, active: true, url: 'https://example.com/' };
  const placeholder = { id: 2, windowId: 10, active: true, url: 'chrome://newtab/' };
  const tabs = new Map([[1, source]]);
  const session = {};
  const calls = { open: [], dismiss: [], remove: [], update: [] };
  let clock = 1000;
  const browser = {
    storage: { session: storage(session), local: storage({ settings: { newTabOverlay: enabled } }) },
    permissions: { contains: async () => permission },
    windows: { onRemoved: event() },
    tabs: {
      onActivated: event(), onCreated: event(), onUpdated: event(), onRemoved: event(),
      query: async () => [...tabs.values()].filter(t => t.active),
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return { ...tabs.get(id) }; },
      update: async (id, props) => { calls.update.push(id); Object.assign(tabs.get(id), props); },
      remove: async id => { calls.remove.push(id); tabs.delete(id); },
    },
  };
  const route = createNewTabRouter({ browser, pageUrl, now: () => clock,
    openOverlay: async tab => { calls.open.push(tab.id); await duringOpen({ source, placeholder, tabs, browser }); return ready; },
    dismissOverlay: async id => { calls.dismiss.push(id); },
  });
  await new Promise(resolve => setImmediate(resolve));
  const create = (overrides = {}) => {
    Object.assign(placeholder, overrides); tabs.set(2, placeholder); source.active = false;
    browser.tabs.onCreated.emit({ ...placeholder });
    browser.tabs.onActivated.emit({ tabId: 2, windowId: placeholder.windowId });
  };
  const run = (overrides = {}) => route({ frameId: 0, url: pageUrl, tab: placeholder, ...overrides });
  return { create, run, source, placeholder, calls, browser, advance: () => { clock += 11000; } };
}

test('fresh new-tab handoff closes only the placeholder after readiness', async () => {
  const h = await setup(); h.create();
  assert.equal((await h.run()).routed, true);
  assert.deepEqual(h.calls, { open: [1], update: [1], remove: [2], dismiss: [] });
  assert.equal((await h.run()).routed, false);
  assert.deepEqual(h.calls.remove, [2]);
});

test('failed overlays, missing consent, old tabs, and explicit destinations are kept', async () => {
  for (const options of [{ ready: false }, { permission: false }, { enabled: false }]) {
    const h = await setup(options); h.create();
    assert.equal((await h.run()).routed, false);
    assert.deepEqual(h.calls.remove, []);
  }
  for (const overrides of [{ active: false }, { discarded: true }, { url: pageUrl }, { pendingUrl: 'https://example.net/' }]) {
    const h = await setup(); h.create(overrides);
    assert.equal((await h.run()).routed, false);
    assert.deepEqual(h.calls.open, []);
  }
  const old = await setup(); old.create(); old.advance();
  assert.equal((await old.run()).routed, false);
  const existing = await setup();
  assert.equal((await existing.run()).routed, false);
});

test('user navigation, tab switching, source navigation, and closed tabs abort the handoff', async () => {
  for (const duringOpen of [
    ({ placeholder }) => { placeholder.pendingUrl = 'https://work.example/'; },
    ({ placeholder }) => { placeholder.url = 'https://work.example/'; },
    ({ placeholder }) => { placeholder.active = false; },
    ({ source }) => { source.url = 'https://work.example/'; },
    ({ source }) => { source.windowId = 11; },
    ({ tabs }) => { tabs.delete(2); },
    ({ browser }) => browser.storage.local.set({ settings: { newTabOverlay: false } }),
  ]) {
    const h = await setup({ duringOpen }); h.create();
    assert.equal((await h.run()).routed, false);
    assert.deepEqual(h.calls.remove, []);
    assert.deepEqual(h.calls.update, []);
    assert.deepEqual(h.calls.dismiss, [1]);
  }
});

test('restricted sources, new windows, embedded senders, and shortcut fallbacks never reroute', async () => {
  const restricted = await setup(); restricted.source.url = 'chrome://settings/'; restricted.create();
  assert.equal((await restricted.run()).routed, false);
  assert.deepEqual(restricted.calls.open, []);
  const window = await setup(); window.create({ windowId: 11 });
  assert.equal((await window.run()).routed, false);
  for (const sender of [{ frameId: 1 }, { url: `${pageUrl}?source=shortcut` }]) {
    const h = await setup(); h.create();
    assert.equal((await h.run(sender)).routed, false);
    assert.deepEqual(h.calls.open, []);
  }
});
