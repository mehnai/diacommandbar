import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewTabRouter } from '../newtab-router.js';

const pageUrl = 'chrome-extension://test/newtab.html';
const diaHome = 'chrome://start-page/18B1D5FE-B1B3-4D87-AB6D-15EB424FA229';
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
};
const storage = data => ({
  get: async key => ({ [key]: data[key] }),
  set: async values => Object.assign(data, values),
  remove: async key => { delete data[key]; },
});

async function setup({ permission = true, enabled = true, separate = true, ready = true, duringOpen = () => {} } = {}) {
  const source = { id: 1, windowId: 10, active: true, url: 'https://example.com/' };
  const placeholder = { id: 2, windowId: 10, active: true, url: 'chrome://newtab/' };
  const tabs = new Map([[1, source]]);
  const session = {};
  const calls = { open: [], dismiss: [], remove: [], update: [] };
  let clock = 1000;
  const browser = {
    storage: { session: storage(session), local: storage({ settings: { newTabOverlay: enabled, newTabPage: separate } }) },
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
  createNewTabRouter({ browser, pageUrl, now: () => clock,
    openOverlay: async tab => { calls.open.push(tab.id); await duringOpen({ source, placeholder, tabs, browser }); return ready; },
    dismissOverlay: async id => { calls.dismiss.push(id); },
  });
  await flush();
  const create = (overrides = {}) => {
    Object.assign(placeholder, overrides); tabs.set(2, placeholder); source.active = !placeholder.active;
    browser.tabs.onCreated.emit({ ...placeholder });
    if (placeholder.active) browser.tabs.onActivated.emit({ tabId: 2, windowId: placeholder.windowId });
  };
  return { create, source, placeholder, calls, browser, tabs, advance: () => { clock += 11000; } };
}

test('fresh new-tab handoff closes only the placeholder after readiness', async () => {
  const h = await setup(); h.create(); await flush();
  assert.deepEqual(h.calls, { open: [1], update: [1], remove: [2], dismiss: [] });
});

test('separate page is optional for both Chromium and Dia; enabling it does not replace existing pages', async () => {
  for (const url of ['chrome://newtab/', 'chrome://new-tab-page/', diaHome, `${diaHome}/`]) {
    for (const separate of [true, false]) {
      const h = await setup({ enabled: false, separate }); h.create({ url }); await flush();
      assert.equal(h.placeholder.url, separate ? pageUrl : url);
      assert.deepEqual(h.calls.update, separate ? [2] : []);
      assert.deepEqual(h.calls.remove, []);
      await h.browser.storage.local.set({ settings: { newTabPage: true } });
      h.browser.tabs.onActivated.emit({ tabId: 2, windowId: 10 }); await flush();
      assert.equal(h.placeholder.url, separate ? pageUrl : url);
    }
  }
});

test('overlay works with the separate page disabled, and failures keep the native home', async () => {
  const h = await setup({ separate: false }); h.create({ url: diaHome }); await flush();
  assert.deepEqual(h.calls, { open: [1], update: [1], remove: [2], dismiss: [] });
  for (const options of [{ ready: false }, { permission: false }, { enabled: false }]) {
    for (const separate of [true, false]) {
      const h = await setup({ ...options, separate }); h.create(); await flush();
      assert.deepEqual(h.calls.remove, []);
      assert.equal(h.placeholder.url, separate ? pageUrl : 'chrome://newtab/');
    }
  }
});

test('explicit destinations, inactive Chromium tabs, and pinned or restored tabs are kept', async () => {
  for (const overrides of [
    { active: false }, { discarded: true }, { pinned: true }, { url: pageUrl },
    { pendingUrl: 'https://example.net/' }, { url: `${pageUrl}?source=shortcut` },
    { openerTabId: 1, url: 'https://example.net/' },
  ]) {
    const h = await setup(); h.create(overrides); await flush();
    assert.deepEqual(h.calls.open, []); assert.deepEqual(h.calls.update, []); assert.deepEqual(h.calls.remove, []);
  }
});

test('user navigation, switching, source navigation, and closed tabs abort the handoff', async () => {
  for (const duringOpen of [
    ({ placeholder }) => { placeholder.pendingUrl = 'https://work.example/'; },
    ({ placeholder }) => { placeholder.url = 'https://work.example/'; },
    ({ placeholder }) => { placeholder.active = false; },
    ({ source }) => { source.url = 'https://work.example/'; },
    ({ source }) => { source.windowId = 11; },
    ({ tabs }) => { tabs.delete(2); },
    ({ browser }) => browser.storage.local.set({ settings: { newTabOverlay: false } }),
  ]) {
    const h = await setup({ duringOpen }); h.create(); await flush();
    assert.deepEqual(h.calls.remove, []); assert.deepEqual(h.calls.update, []); assert.deepEqual(h.calls.dismiss, [1]);
  }
});

test('restricted sources and new windows respect the separate-page fallback choice', async () => {
  for (const separate of [true, false]) {
    for (const newWindow of [true, false]) {
      const h = await setup({ separate }); h.source.url = 'chrome://settings/';
      h.create({ windowId: newWindow ? 11 : 10, url: diaHome }); await flush();
      assert.equal(h.placeholder.url, separate ? pageUrl : diaHome);
      assert.deepEqual(h.calls.open, []); assert.deepEqual(h.calls.remove, []);
    }
  }
});

test('Dia homepage is recognized when its URL arrives after creation', async () => {
  const h = await setup({ enabled: false }); h.create({ url: '' });
  h.placeholder.url = diaHome; h.browser.tabs.onUpdated.emit(2, { url: diaHome }); await flush();
  assert.equal(h.placeholder.url, pageUrl); assert.deepEqual(h.calls.update, [2]);
});

test('Dia routing ignores existing pages, expired candidates, chat paths, and explicit destinations', async () => {
  for (const overrides of [
    { url: diaHome, active: false }, { url: diaHome, pinned: true }, { url: diaHome, discarded: true },
    { url: diaHome, pendingUrl: 'https://example.net/' }, { url: `${diaHome}/chat` },
    { url: `${diaHome}?conversation=existing` }, { url: 'https://start-page.example/' }, { url: 'https://example.net/' },
  ]) {
    const h = await setup(); h.create(overrides); h.browser.tabs.onUpdated.emit(2, { url: diaHome }); await flush();
    assert.deepEqual(h.calls.update, []); assert.deepEqual(h.calls.open, []);
  }
  const existing = await setup(); existing.source.url = diaHome;
  existing.browser.tabs.onUpdated.emit(1, { url: diaHome }); await flush(); assert.deepEqual(existing.calls.update, []);
  const expired = await setup(); expired.create({ url: '' }); expired.advance();
  expired.placeholder.url = diaHome; expired.browser.tabs.onUpdated.emit(2, { url: diaHome }); await flush();
  assert.deepEqual(expired.calls.update, []);
});

test('a link with an initially empty URL cannot later become a new-tab candidate', async () => {
  const h = await setup(); h.create({ url: '', active: false, openerTabId: 1 });
  h.placeholder.url = 'https://example.net/'; h.browser.tabs.onUpdated.emit(2, { url: h.placeholder.url }); await flush();
  h.placeholder.url = diaHome; h.placeholder.active = true; h.browser.tabs.onUpdated.emit(2, { url: diaHome }); await flush();
  assert.deepEqual(h.calls.update, []);
});

test('Dia placeholders with an opener wait for both the homepage URL and activation', async () => {
  for (const activationFirst of [true, false]) {
    const h = await setup(); h.create({ url: '', active: false, openerTabId: 1 }); await flush();
    assert.deepEqual(h.calls.update, []);
    const activate = () => { h.placeholder.active = true; h.browser.tabs.onActivated.emit({ tabId: 2, windowId: 10 }); };
    if (activationFirst) { activate(); await flush(); }
    h.placeholder.url = diaHome; h.browser.tabs.onUpdated.emit(2, { url: diaHome }); await flush();
    if (!activationFirst) { assert.deepEqual(h.calls.update, []); activate(); await flush(); }
    assert.deepEqual(h.calls, { open: [1], update: [1], remove: [2], dismiss: [] });
  }
});

test('routing rechecks navigation, selection, and tab existence before updating', async () => {
  for (const change of [
    h => { h.placeholder.pendingUrl = 'https://work.example/'; }, h => { h.placeholder.active = false; },
    h => { h.placeholder.windowId = 11; }, h => { h.tabs.delete(2); },
  ]) {
    const h = await setup(); h.create({ url: '' }); h.placeholder.url = diaHome;
    h.browser.tabs.onUpdated.emit(2, { url: diaHome }); change(h); await flush();
    assert.deepEqual(h.calls.update, []);
  }
});
