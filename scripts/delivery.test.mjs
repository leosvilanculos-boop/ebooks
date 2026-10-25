import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { registerWalledRoutes } from '../walled-checkout.js';
import { resolveStoreTelegram } from '../delivery.js';

async function withCheckout(options, run) {
  const env = {
    WALLED_API_BASE_URL: 'https://walled.test/api/v1/integrations',
    WALLED_APP_ORIGIN: 'https://secure.test', WALLED_API_KEY: 'test-key',
    WALLED_PRODUCT_ID: 'product-demo',
  };
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const state = {
    order_id: 'order-demo', video_id: 'registered-video', bundle: false,
    title: 'Purchased content', amount_minor: 3500, currency: 'usd',
    product_id: 'product-demo', session_id: 'session-demo', status: 'pending',
    ...options.order,
  };
  const payment = {
    orderId: state.order_id, productId: state.product_id, sessionId: state.session_id,
    amount: 3500, currency: 'usd', status: 'paid', ...options.payment,
  };
  const calls = { videos: [], telegram: 0, records: 0 };
  const db = { from(table) {
    const filters = [];
    let updates;
    return {
      select() { return this; }, limit() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      update(value) { updates = value; return this; },
      async maybeSingle() {
        if (table === 'site_config') {
          calls.telegram++;
          return { data: { telegram_username: '@main_store' }, error: null };
        }
        assert.equal(table, 'walled_orders');
        if (updates && options.refundDuringUpdate) state.status = 'refunded';
        if (!filters.every(([key, value]) => state[key] === value)) return { data: null, error: null };
        if (updates) Object.assign(state, updates);
        return { data: structuredClone(state), error: null };
      },
    };
  } };
  const app = express();
  app.locals.getSupabase = () => db;
  registerWalledRoutes(app, {
    getVideoForCheckout: async id => { calls.videos.push(id); return { product_link: options.link || '' }; },
    getAllVideosForBundle: async () => [],
    getTelegramUsername: () => resolveStoreTelegram(db, 'secure_fallback'),
    recordWalledPurchase: async () => { calls.records++; return { ok: true }; },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith(env.WALLED_API_BASE_URL)
    ? Promise.resolve(new Response(JSON.stringify(payment), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : originalFetch(url, init);
  try {
    await run(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('verified payment returns the registered video link, ignoring browser delivery parameters', async () => {
  await withCheckout({ link: 'https://content.example/folder?key=access' }, async (base, calls) => {
    const response = await fetch(base + '/api/walled-status?sessionId=session-demo&videoId=another-video&product_link=https://untrusted.example');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    const result = await response.json();
    assert.equal(result.status, 'paid');
    assert.equal(result.product_link, 'https://content.example/folder?key=access');
    assert.equal(result.delivery_via_telegram, false);
    assert.equal(result.telegram_username, '');
    assert.deepEqual(calls.videos, ['registered-video']);
    assert.equal(calls.records, 1);
    assert.equal(calls.telegram, 0);
  });
});

test('missing or invalid product links fall back to the main store Telegram configuration', async () => {
  for (const link of ['', '  ', 'javascript:alert(1)', 'data:text/html,test', 'https://']) {
    await withCheckout({ link }, async (base, calls) => {
      const result = await (await fetch(base + '/api/walled-status?sessionId=session-demo')).json();
      assert.equal(result.product_link, '');
      assert.equal(result.delivery_via_telegram, true);
      assert.equal(result.telegram_username, 'main_store');
      assert.equal(calls.telegram, 1);
    });
  }
});

test('bundle delivery uses Telegram rather than an individual video link', async () => {
  await withCheckout({ order: { video_id: null, bundle: true }, link: 'https://content.example/single' }, async (base, calls) => {
    const result = await (await fetch(base + '/api/walled-status?sessionId=session-demo')).json();
    assert.equal(result.product_link, '');
    assert.equal(result.telegram_username, 'main_store');
    assert.deepEqual(calls.videos, []);
  });
});

test('unconfirmed, mismatched or revoked payments never expose delivery information', async () => {
  for (const options of [
    { payment: { status: 'pending' } },
    { payment: { status: 'refunded' } },
    { payment: { amount: 1 } },
    { order: { status: 'refunded' }, payment: { status: 'paid' } },
    { refundDuringUpdate: true },
  ]) {
    await withCheckout({ ...options, link: 'https://content.example/private' }, async (base, calls) => {
      const result = await (await fetch(base + '/api/walled-status?sessionId=session-demo')).json();
      assert.notEqual(result.status, 'paid');
      assert.equal(result.product_link, undefined);
      assert.equal(result.telegram_username, undefined);
      assert.deepEqual(calls.videos, []);
      assert.equal(calls.telegram, 0);
    });
  }
});

async function showSuccess(result, ok = true) {
  const elements = Object.fromEntries(['status', 'delivery', 'content-link-wrap', 'content-link', 'copy-content-link', 'payment-heading'].map(id => [id, {
    hidden: true, value: '', textContent: '', addEventListener(name, fn) { this[name] = fn; },
  }]));
  const timers = [];
  const browser = {
    URL, URLSearchParams, navigator: { clipboard: { async writeText(value) { browser.copied = value; } } },
    window: { location: { search: '?sessionId=session-demo&product_link=https://untrusted.example' } },
    document: { getElementById(id) { return elements[id]; } },
    fetch: async () => ({ ok, json: async () => result }),
    setTimeout(fn) { timers.push(fn); },
  };
  await vm.runInNewContext(readFileSync(new URL('../public/js/payment-success.js', import.meta.url), 'utf8'), browser);
  return { elements, timers, browser };
}

test('success screen shows and copies the content link without redirecting to Telegram', async () => {
  const { elements, browser } = await showSuccess({ status: 'paid', product_link: 'https://content.example/folder', telegram_username: 'main_store' });
  assert.equal(elements['content-link-wrap'].hidden, false);
  assert.equal(elements['content-link'].value, 'https://content.example/folder');
  assert.equal(elements.delivery.href, 'https://content.example/folder');
  assert.equal(elements.delivery.hidden, false);
  await elements['copy-content-link'].click();
  assert.equal(browser.copied, 'https://content.example/folder');
});

test('success screen shows the configured Telegram button only when there is no content link', async () => {
  const { elements } = await showSuccess({ status: 'paid', product_link: '', telegram_username: '@main_store', title: 'Purchased content', amount: 35, currency: 'USD' });
  assert.equal(elements['content-link-wrap'].hidden, true);
  assert.equal(elements.delivery.hidden, false);
  const url = new URL(elements.delivery.href);
  assert.equal(url.pathname, '/main_store');
  assert.match(url.searchParams.get('text'), /Payment reference: session-demo/);
});

test('pending and rejected responses keep both delivery options hidden', async () => {
  for (const [result, ok] of [[{ status: 'pending' }, true], [{ status: 'paid', product_link: 'https://content.example/private' }, false]]) {
    const { elements, timers } = await showSuccess(result, ok);
    assert.equal(elements.delivery.hidden, true);
    assert.equal(elements['content-link-wrap'].hidden, true);
    assert.equal(timers.length, 1);
  }
});
