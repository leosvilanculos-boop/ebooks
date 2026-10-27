import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { registerWalledRoutes } from '../walled-checkout.js';
import { createPurchaseRecorder } from '../purchases.js';

async function withCheckoutServer(options, run) {
  const env = {
    NODE_ENV: options.nodeEnv || 'test', WALLED_API_BASE_URL: 'https://api.walled.test/api/v1/integrations',
    WALLED_APP_ORIGIN: 'https://secure.test', WALLED_API_KEY: 'mock-test-key', WALLED_WEBHOOK_SECRET: 'mock-signing-secret',
    WALLED_VARIABLE_PRICING: 'false', WALLED_PRODUCT_ID: '', WALLED_FIXED_PRICE_USD: '',
    WALLED_FIXED_PRODUCTS_JSON: JSON.stringify({ 35: 'ebook-35', 50: 'ebook-50', 90: 'ebook-90', 100: 'ebook-100' }),
    WALLED_VIDEO_FIXED_PRODUCTS_JSON: JSON.stringify({ 90: 'video-90' }), WALLED_VIDEO_BUNDLE_PRODUCT_ID: '',
    WALLED_CHECKOUT_NAMES_JSON: JSON.stringify({ 'ebook-90': 'Digital Product Launch Blueprint', 'video-90': 'Video catalog purchase' }),
    WALLED_CHECKOUT_ORIGIN: 'https://checkout.walled.test', WALLED_ENVIRONMENT: options.environment || 'test',
    WALLED_STRICT_TEST_MODE: options.strict ? 'true' : 'false',
    ...options.env,
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const tables = { walled_orders: [], walled_webhook_events: [], purchases: [] };
  const calls = { creates: [], lookups: 0 };
  const sessions = new Map();
  let failPurchase = options.failPurchaseOnce;
  const db = { from(name) {
    const filters = [];
    let insertion;
    let update;
    const query = {
      select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      insert(value) { insertion = structuredClone(value); return this; }, update(value) { update = structuredClone(value); return this; },
      async execute() {
        const rows = tables[name];
        assert.ok(rows, 'Unexpected table: ' + name);
        if (insertion) {
          if (name === 'purchases' && failPurchase) { failPurchase = false; return { data: null, error: { message: 'Temporary storage failure' } }; }
          const key = { walled_orders: 'request_key', walled_webhook_events: 'event_id', purchases: 'transaction_id' }[name];
          if (rows.some(row => row[key] === insertion[key])) return { data: null, error: { code: '23505' } };
          const row = { ...insertion, id: insertion.id || crypto.randomUUID() };
          rows.push(row);
          return { data: structuredClone(row), error: null };
        }
        const row = rows.find(row => filters.every(([key, value]) => row[key] === value));
        if (row && update) Object.assign(row, update);
        return { data: row ? structuredClone(row) : null, error: null };
      },
      maybeSingle() { return this.execute(); }, single() { return this.execute(); },
      then(resolve, reject) { return this.execute().then(resolve, reject); },
    };
    return query;
  } };
  const app = express();
  app.use(express.json({ verify(req, res, body) { req.rawBody = Buffer.from(body); } }));
  app.locals.getSupabase = () => db;
  const recorder = createPurchaseRecorder(() => db);
  registerWalledRoutes(app, {
    getVideoForCheckout: async id => ({ id, title: 'Selected video', price: 90, is_active: true, is_free: false, product_link: 'https://content.test/private' }),
    getAllVideosForBundle: async () => [], getTelegramUsername: async () => 'sweet1books',
    recordWalledPurchase: recorder.recordWalledPurchase,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(env.WALLED_API_BASE_URL + '/checkout/sessions')) {
      if (init?.method === 'POST') {
        const payload = JSON.parse(init.body);
        calls.creates.push({ payload, idempotencyKey: init.headers['Idempotency-Key'] });
        if (options.timeoutOnce && calls.creates.length === 1) throw new Error('Simulated network timeout');
        const amount = payload.productId === 'ebook-35' ? 3500 : payload.productId === 'ebook-50' ? 5000 : payload.productId === 'ebook-100' ? 10000 : 9000;
        const session = { ...payload, sessionId: crypto.randomUUID(), checkoutUrl: options.checkoutUrl || 'https://checkout.walled.test/session/demo', checkoutMode: options.mode || 'embedded', amount, currency: 'usd', environment: options.providerEnvironment || 'test', status: 'pending', ...options.responseOverrides };
        sessions.set(session.sessionId, session);
        return Response.json(session);
      }
      calls.lookups++;
      return Response.json(sessions.get(target.split('/').pop()) || {}, { status: sessions.has(target.split('/').pop()) ? 200 : 404 });
    }
    assert.ok(target.startsWith(base), 'Tests must never contact an external server: ' + target);
    return originalFetch(url, init);
  };
  const helpers = {
    base, tables, calls, sessions, env,
    async review(query = 'product_name=Digital%20Product%20Launch%20Blueprint') {
      const response = await fetch(base + '/checkout?' + query);
      const html = await response.text();
      const data = html.match(/<script id="checkout-data" type="application\/json">([^]*?)<\/script>/)?.[1];
      return { response, html, cookie: response.headers.get('set-cookie')?.split(';')[0], data: data ? JSON.parse(data) : null };
    },
    post(review, body = {}, headers = {}) {
      return fetch(base + '/api/walled-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.NODE_ENV === 'production' ? env.WALLED_APP_ORIGIN : base, Cookie: review.cookie || '', ...headers }, body: JSON.stringify({ ...review.data?.input, requestKey: review.data?.requestKey, ...body }) });
    },
    event(session, type = 'payment.succeeded', overrides = {}) {
      return { id: crypto.randomUUID(), type, data: { ...session, ...overrides } };
    },
    webhook(event, timestamp = Math.floor(Date.now() / 1000), signatureOverride) {
      const body = JSON.stringify(event);
      const digest = crypto.createHmac('sha256', env.WALLED_WEBHOOK_SECRET).update(String(timestamp) + '.' + body).digest('hex');
      return fetch(base + '/api/webhooks/walled', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Walled-Signature': signatureOverride || `t=${timestamp},v1=${digest}` }, body });
    },
  };
  try { await run(helpers); }
  finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('Secure landing page shows only the selected order, payment name and button; no session is created by navigation', async () => {
  await withCheckoutServer({}, async h => {
    const review = await h.review('product_name=Digital%20Product%20Launch%20Blueprint&amount=0.01&display_title=Fake');
    assert.equal(review.response.status, 200);
    assert.match(review.html, /\$90\.00/);
    assert.match(review.html, /Product name in the payment form/);
    assert.match(review.html, /id="pay-button"/);
    assert.doesNotMatch(review.html, /Best Sellers|class="catalog"|mock-test-key|mock-signing-secret|Fake/);
    assert.equal(h.calls.creates.length, 0);
    assert.equal(h.tables.walled_orders.length, 0);
  });
});

test('payment API uses server prices and titles and returns the confirmed embedded mode', async () => {
  await withCheckoutServer({ strict: true }, async h => {
    const review = await h.review();
    const response = await h.post(review, { amount: 1, productId: 'untrusted', orderId: 'untrusted', successUrl: 'https://untrusted.test', domainMode: 'legacy' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.checkoutMode, 'embedded');
    assert.ok(result.sessionId);
    const payload = h.calls.creates[0].payload;
    assert.equal(payload.productId, 'ebook-90');
    assert.equal(payload.metadata.title, 'Digital Product Launch Blueprint');
    assert.equal(payload.checkoutMode, 'embedded');
    assert.equal(payload.domainMode, 'strict');
    assert.equal(payload.amount, undefined);
    assert.equal(payload.successUrl, 'https://secure.test/payment/success');
    assert.notEqual(payload.orderId, 'untrusted');
    assert.equal(h.tables.walled_orders[0].amount_minor, 9000);
  });
});

test('anonymous checkout requires its own cookie and a same-origin request', async () => {
  await withCheckoutServer({}, async h => {
    const review = await h.review();
    assert.equal((await h.post(review, {}, { Origin: 'https://untrusted.test' })).status, 403);
    assert.equal((await h.post(review, {}, { Cookie: '' })).status, 403);
    assert.equal(h.calls.creates.length, 0);
  });
});

test('retries reuse the stored session; a different buyer or purchase cannot reuse its request key', async () => {
  await withCheckoutServer({}, async h => {
    const review = await h.review();
    const first = await (await h.post(review)).json();
    const repeat = await (await h.post(review)).json();
    assert.deepEqual(repeat, first);
    assert.equal(h.calls.creates.length, 1);
    assert.equal((await h.post(review, { product_name: 'Family Comfort Food Recipes' })).status, 409);
    const stranger = await h.review();
    assert.equal((await h.post(stranger, { requestKey: review.data.requestKey })).status, 403);
    const status = await fetch(h.base + '/api/walled-status?sessionId=' + first.sessionId, { headers: { Cookie: stranger.cookie } });
    assert.equal(status.status, 403);
  });
});

test('uncertain checkout creation retries the exact persisted payload, including its domain mode', async () => {
  await withCheckoutServer({ strict: true, timeoutOnce: true }, async h => {
    const review = await h.review();
    assert.equal((await h.post(review)).status, 500);
    process.env.WALLED_STRICT_TEST_MODE = 'false';
    assert.equal((await h.post(review)).status, 200);
    assert.deepEqual(h.calls.creates[0], h.calls.creates[1]);
    assert.equal(h.tables.walled_orders.length, 1);
  });
});

test('legacy gateway responses retain redirect mode and production never sends the strict-test override', async () => {
  await withCheckoutServer({ mode: 'redirect', strict: true, environment: 'production', nodeEnv: 'production', providerEnvironment: 'production' }, async h => {
    const review = await h.review();
    assert.equal((await (await h.post(review, { domainMode: 'strict' })).json()).checkoutMode, 'redirect');
    assert.equal(h.calls.creates[0].payload.domainMode, undefined);
  });
});

test('cancellation returns to the same Secure order without creating or failing a payment', async () => {
  await withCheckoutServer({}, async h => {
    const review = await h.review();
    await h.post(review);
    const response = await fetch(h.base + '/payment/cancel?requestKey=' + review.data.requestKey, { headers: { Cookie: review.cookie }, redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /^\/checkout\?/);
    assert.equal(new URL(response.headers.get('location'),h.base).searchParams.get('requestKey'),review.data.requestKey);
    assert.equal(h.tables.walled_orders[0].status, 'pending');
    assert.equal(h.calls.creates.length, 1);
  });
});

function checkoutBrowser(mode = 'embedded') {
  const handlers = {};
  const requests = [];
  const navigations = [];
  const scripts = [];
  let paid = false;
  let mountOptions;
  const elements = {
    'checkout-data': { textContent: JSON.stringify({input:{product_name:'Digital Product Launch Blueprint'},requestKey:crypto.randomUUID()}) },
    'pay-button': { addEventListener(name, fn) { handlers[name] = fn; } },
    'checkout-status': {},
  };
  const browser = {
    URL, document: {
      getElementById: id => elements[id], createElement() { return { remove() {} }; },
      head: { appendChild(script) {
        scripts.push(script.src);
        browser.window.WalledGateway = { mount(options) { mountOptions = options; return {destroy(){}}; } };
        script.onload();
      } },
    },
    window: { addEventListener() {}, location: { assign(url) { navigations.push(url); } } },
    async fetch(url, init) {
      requests.push({url,init});
      return { ok: true, async json() { return init?.method === 'POST'
        ? { checkoutMode:mode,checkoutUrl:'https://checkout.walled.test/session/demo',sessionId:'verified-session' }
        : {status:paid?'paid':'pending'}; } };
    },
  };
  vm.runInNewContext(readFileSync(new URL('../public/js/checkout.js',import.meta.url),'utf8'),browser);
  return { handlers,requests,navigations,scripts,elements,get mount(){return mountOptions;},confirm(){paid=true;} };
}

test('browser mounts the same-origin Walled SDK and verifies events with the server before navigating', async () => {
  const browser=checkoutBrowser();
  await browser.handlers.click();
  assert.deepEqual(browser.scripts,['https://checkout.walled.test/walled-gateway.js']);
  assert.equal(browser.mount.container,'#walled-checkout');
  assert.equal(browser.elements['pay-button'].hidden,true);
  browser.mount.onResult({sessionId:'untrusted-session',status:'paid'});
  assert.equal(browser.requests.length,1);
  browser.mount.onResult({sessionId:'verified-session',status:'paid'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(browser.navigations.length,0);
  browser.confirm();
  browser.mount.onResult({sessionId:'verified-session',status:'paid'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(browser.navigations,['/payment/success?sessionId=verified-session']);
});

test('browser follows an explicit legacy redirect without mounting the SDK', async () => {
  const browser=checkoutBrowser('redirect');
  await browser.handlers.click();
  assert.deepEqual(browser.navigations,['https://checkout.walled.test/session/demo']);
  assert.equal(browser.scripts.length,0);
});

test('unexpected checkout origins are rejected before the browser can load their SDK', async () => {
  await withCheckoutServer({ checkoutUrl: 'https://untrusted.test/session/demo' }, async h => {
    assert.equal((await h.post(await h.review())).status, 502);
  });
});

test('a session for another product is rejected even if its amount matches', async () => {
  await withCheckoutServer({ responseOverrides: {productId:'another-product'} }, async h => {
    assert.equal((await h.post(await h.review())).status,409);
  });
});

test('a retry cannot switch between two different titles sold at the same price', async () => {
  await withCheckoutServer({}, async h => {
    const review=await h.review('product_name=Digital%20Marketing%202025');
    assert.equal((await h.post(review)).status,200);
    assert.equal((await h.post(review,{product_name:'Penis Enlargement Protocol'})).status,409);
    assert.equal(h.calls.creates.length,1);
  });
});

test('unknown catalog products are rejected and the main-store title is resolved on the server', async () => {
  await withCheckoutServer({}, async h => {
    assert.equal((await h.review('product_name=Unknown&amount=90')).response.status, 400);
    const review = await h.review('video_id=registered-video&amount=1&display_title=Fake');
    assert.match(review.html, /Selected video/);
    assert.match(review.html, /Video catalog purchase/);
    assert.doesNotMatch(review.html, /Fake/);
    assert.equal((await h.post(review)).status, 200);
    assert.equal(h.calls.creates[0].payload.productId, 'video-90');
  });
});

test('a video purchase cannot silently use a gateway registered for an ebook', async () => {
  await withCheckoutServer({ env: { WALLED_VIDEO_FIXED_PRODUCTS_JSON: '{}', WALLED_FIXED_PRODUCTS_JSON: '{"90":"7fb048d1-3786-49aa-9cc3-b8944cb5418a"}' } }, async h => {
    assert.equal((await h.review('video_id=registered-video')).response.status, 503);
    assert.equal(h.calls.creates.length, 0);
  });
});

test('valid signed Development confirmation is idempotent and never grants live goods or ledger entries', async () => {
  await withCheckoutServer({}, async h => {
    const review = await h.review();
    const sessionId = (await (await h.post(review)).json()).sessionId;
    const session = h.sessions.get(sessionId);
    session.status = 'paid';
    const event = h.event(session);
    assert.equal((await h.webhook(event)).status, 200);
    assert.equal((await h.webhook(event)).status, 200);
    assert.equal(h.tables.walled_webhook_events.length, 1);
    assert.ok(h.tables.walled_webhook_events[0].processed_at);
    assert.equal(h.tables.walled_orders[0].status, 'paid');
    const result = await (await fetch(h.base + '/api/walled-status?sessionId=' + sessionId, { headers: { Cookie: review.cookie } })).json();
    assert.equal(result.test, true);
    assert.equal(result.product_link, undefined);
    assert.equal(h.tables.purchases.length, 0);
  });
});

test('invalid, stale, future and ambiguous signatures are rejected before persistence', async () => {
  await withCheckoutServer({}, async h => {
    for (const [timestamp, signature] of [
      [undefined, 't=1,v1=' + '0'.repeat(64)],
      [Math.floor(Date.now() / 1000) - 301],
      [Math.floor(Date.now() / 1000) + 301],
      [undefined, 't=1,t=2,v1=' + '0'.repeat(64)],
    ]) assert.equal((await h.webhook({id:'untrusted',type:'payment.succeeded',data:{}}, timestamp, signature)).status, 400);
    assert.equal(h.tables.walled_webhook_events.length, 0);
  });
});

test('mock production confirmation fulfills once and late events cannot reverse refunds', async () => {
  await withCheckoutServer({ nodeEnv: 'production', environment: 'production', providerEnvironment: 'production' }, async h => {
    const review = await h.review();
    const sessionId = (await (await h.post(review)).json()).sessionId;
    const session = h.sessions.get(sessionId);
    session.status = 'paid';
    const paid = h.event(session);
    assert.equal((await h.webhook(paid)).status, 200);
    assert.equal((await h.webhook(paid)).status, 200);
    assert.equal((await h.webhook(h.event(session))).status, 200);
    assert.equal(h.tables.purchases.length, 1);
    session.status = 'refunded';
    assert.equal((await h.webhook(h.event(session,'payment.refunded'))).status, 200);
    session.status = 'paid';
    assert.equal((await h.webhook(h.event(session))).status, 200);
    assert.equal(h.tables.walled_orders[0].status, 'refunded');
    assert.equal(h.tables.purchases.length, 1);
  });
});

test('a failed fulfillment remains retryable and a mismatched event cannot fulfill it', async () => {
  await withCheckoutServer({ nodeEnv: 'production', environment: 'production', providerEnvironment: 'production', failPurchaseOnce: true }, async h => {
    const review = await h.review();
    const sessionId = (await (await h.post(review)).json()).sessionId;
    const session = h.sessions.get(sessionId);
    session.status = 'paid';
    assert.equal((await h.webhook(h.event(session,'payment.succeeded',{amount:1}))).status, 500);
    assert.equal(h.tables.purchases.length, 0);
    const event = h.event(session);
    assert.equal((await h.webhook(event)).status, 500);
    assert.equal(h.tables.walled_webhook_events.find(row=>row.event_id===event.id).processed_at, undefined);
    assert.equal((await h.webhook(event)).status, 200);
    assert.equal(h.tables.purchases.length, 1);
  });
});
