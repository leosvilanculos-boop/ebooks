import crypto from 'node:crypto';
import { resolveOrderDelivery } from './delivery.js';
import { findCatalogPurchase, gatewayName, knownEbookGateway } from './checkout-catalog.js';
import { checkoutOwner, ownsCheckout, renderCheckoutPage } from './checkout-page.js';

const ALLOWED_EVENTS = new Set([
  'payment.succeeded', 'payment.failed', 'payment.expired',
  'payment.partially_refunded', 'payment.refunded', 'payment.disputed', 'payment.dispute_lost',
]);

function config() {
  const jsonSetting = name => {
    try { const value = JSON.parse(process.env[name] || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  };
  let fixedProducts = {};
  try {
    const raw = String(process.env.WALLED_FIXED_PRODUCTS_JSON || '').trim();
    if (raw) fixedProducts = JSON.parse(raw);
  } catch { fixedProducts = {}; }
  return {
    baseUrl: String(process.env.WALLED_API_BASE_URL || '').trim().replace(/\/+$/, ''),
    appOrigin: String(process.env.WALLED_APP_ORIGIN || '').trim().replace(/\/+$/, ''),
    apiKey: String(process.env.WALLED_API_KEY || '').trim(),
    productId: String(process.env.WALLED_PRODUCT_ID || '').trim(),
    videoBundleProductId: String(process.env.WALLED_VIDEO_BUNDLE_PRODUCT_ID || '').trim(),
    videoProducts: jsonSetting('WALLED_VIDEO_FIXED_PRODUCTS_JSON'),
    checkoutNames: jsonSetting('WALLED_CHECKOUT_NAMES_JSON'),
    checkoutOrigin: String(process.env.WALLED_CHECKOUT_ORIGIN || 'https://trywalled.com').trim(),
    strictTest: String(process.env.WALLED_STRICT_TEST_MODE || '').toLowerCase() === 'true',
    environment: String(process.env.WALLED_ENVIRONMENT || '').toLowerCase(),
    webhookSecret: String(process.env.WALLED_WEBHOOK_SECRET || '').trim(),
    variablePricing: String(process.env.WALLED_VARIABLE_PRICING || '').trim().toLowerCase() === 'true',
    fixedPriceUsd: Number(process.env.WALLED_FIXED_PRICE_USD),
    fixedProducts,
    allowedPrices: String(process.env.WALLED_ALLOWED_PRICES_USD || '')
      .split(',').map((price) => Number(price.trim()))
      .filter((price) => Number.isFinite(price) && price > 0),
  };
}

function exactProductForPrice(c, amount) {
  const target = minorUnits(amount);
  const entries = Object.entries(c.fixedProducts || {})
    .map(([price, productId]) => ({ amount: Number(price), productId: String(productId || '').trim() }))
    .filter((x) => Number.isFinite(x.amount) && x.amount > 0 && x.productId);
  const exact = entries.find((x) => minorUnits(x.amount) === target);
  if (exact) return exact;
  if (c.variablePricing && c.productId && c.allowedPrices.some((price) => minorUnits(price) === target)) {
    return { amount, productId: c.productId };
  }
  if (Number.isFinite(c.fixedPriceUsd) && c.fixedPriceUsd > 0 && c.productId
    && minorUnits(c.fixedPriceUsd) === target) {
    return { amount: c.fixedPriceUsd, productId: c.productId };
  }
  return null;
}

function isConfigured(c) {
  try {
    const base = new URL(c.baseUrl);
    const origin = new URL(c.appOrigin);
    return base.protocol === 'https:' && origin.protocol === 'https:' && origin.origin === c.appOrigin
      && origin.pathname === '/' && !origin.search && !origin.hash
      && Boolean(c.apiKey && (c.productId || (!c.variablePricing && Object.keys(c.fixedProducts || {}).length)));
  } catch { return false; }
}
function uuid() { return crypto.randomUUID(); }
function minorUnits(amount) { return Math.round(Number(amount) * 100); }

function signatureIsValid(rawBody, header, secret) {
  if (!Buffer.isBuffer(rawBody) || !header || !secret) return false;
  const parts = String(header).split(',');
  const values = new Map();
  for (const part of parts) {
    const match = part.trim().match(/^(t|v1)=([a-fA-F0-9]+)$/);
    if (!match || values.has(match[1])) return false;
    values.set(match[1], match[2]);
  }
  const timestamp = values.get('t');
  const signature = values.get('v1');
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature || signature.length !== 64) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp, 'ascii').update('.', 'ascii').update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function orderKey(req) {
  const key = String(req.body?.requestKey || req.query?.requestKey || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key) ? key.toLowerCase() : '';
}

export function registerWalledRoutes(app, { getVideoForCheckout, getAllVideosForBundle, getTelegramUsername, recordWalledPurchase }) {
  function checkoutError(status, message) { return Object.assign(new Error(message), { status }); }

  async function resolvePurchase(input, c) {
    const isBundle = input.bundle === true || String(input.bundle || '').toLowerCase() === 'true';
    let video = null;
    let amount;
    let title;
    let selectedProduct;
    if (isBundle) {
      if (!c.videoBundleProductId || knownEbookGateway(c.videoBundleProductId)) throw checkoutError(503, 'The video bundle requires its own Walled product. Contact support.');
      const videos = await getAllVideosForBundle();
      if (!videos.length) throw checkoutError(404, 'No active videos are available.');
      amount = 100;
      title = 'All videos and folders';
      selectedProduct = { amount, productId: c.videoBundleProductId };
    } else {
      const rawId = input.videoId ?? input.video_id;
      if (rawId != null && typeof rawId !== 'string') throw checkoutError(400, 'Invalid purchase identity.');
      const videoId = String(rawId || '').trim();
      if (videoId) {
        video = await getVideoForCheckout(videoId);
        if (!video || !video.is_active || video.is_free) throw checkoutError(404, 'This item is not available for purchase.');
        amount = Number(video.price);
        title = String(video.title || 'Digital video').slice(0, 180);
        selectedProduct = exactProductForPrice({ ...c, fixedProducts: c.videoProducts }, amount)
          || exactProductForPrice(c, amount);
        if (selectedProduct && knownEbookGateway(selectedProduct.productId)) {
          throw checkoutError(503, 'This item needs a payment gateway that matches the content being purchased. Contact support.');
        }
      } else {
        const item = findCatalogPurchase(input);
        if (!item) throw checkoutError(400, 'Choose a product from the store before checkout.');
        amount = item.amount;
        title = item.title;
        selectedProduct = exactProductForPrice(c, amount);
      }
    }
    if (!Number.isFinite(amount) || amount <= 0 || minorUnits(amount) > 99999999) throw checkoutError(400, 'The configured purchase price is invalid.');
    if (!selectedProduct || minorUnits(selectedProduct.amount) !== minorUnits(amount)) throw checkoutError(503, 'This purchase does not have an exact configured payment price. Contact support.');
    return { video, amount, title, isBundle, staticCatalogPurchase: !video && !isBundle, selectedProduct,
      checkoutName: gatewayName(selectedProduct.productId, c.checkoutNames) };
  }

  const reviewCheckout = async (req, res) => {
    res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
    try {
      const c = config();
      const purchase = await resolvePurchase(req.query, c);
      checkoutOwner(req, res, true);
      const identity = purchase.video ? { videoId: purchase.video.id }
        : purchase.isBundle ? { bundle: true } : { product_name: purchase.title };
      return res.type('html').send(renderCheckoutPage(purchase, identity, orderKey(req) || uuid(), req.query.cancelled === '1'));
    } catch (error) { return res.status(error.status || 500).type('text').send(error.status ? error.message : 'Could not load this purchase. Please try again.'); }
  };

  const startCheckout = async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    const input = req.method === 'GET' ? req.query : req.body;
    const sendError = (status, error) => req.method === 'GET'
      ? res.status(status).type('text').send(error)
      : res.status(status).json({ error });
    const c = config();
    if (!isConfigured(c)) return sendError(503, 'Walled checkout is not configured on the server.');
    if (!c.variablePricing && !Object.keys(c.fixedProducts || {}).length && (!Number.isFinite(c.fixedPriceUsd) || c.fixedPriceUsd <= 0)) {
      return sendError(503, 'Configure at least one fixed Walled product price.');
    }
    if (!input || typeof input !== 'object') return sendError(400, 'Invalid checkout request.');

    try {
      const expectedOrigin = process.env.NODE_ENV === 'production' ? c.appOrigin : `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') !== expectedOrigin) return sendError(403, 'Open the payment page before starting checkout.');
      const owner = checkoutOwner(req, res);
      if (!owner) return sendError(403, 'Open the payment page before starting checkout.');
      const supabase = typeof req.app.locals.getSupabase === 'function' ? req.app.locals.getSupabase() : null;
      if (!supabase) return sendError(503, 'Checkout storage is unavailable.');
      const requestKey = orderKey(req);
      if (!requestKey) return sendError(400, 'Invalid checkout request key.');

      const { video, amount, title, isBundle, staticCatalogPurchase, selectedProduct } = await resolvePurchase(input, c);
      const requestedAmountMinor = minorUnits(amount);
      const chargedAmountMinor = minorUnits(selectedProduct.amount);

      let { data: order, error } = await supabase.from('walled_orders').select('*').eq('request_key', requestKey).maybeSingle();
      if (error) throw error;
      if (order) {
        if (!ownsCheckout(order, owner)) return sendError(403, 'This purchase belongs to another checkout session.');
        if (order.video_id !== (video?.id || null) || order.bundle !== isBundle
          || order.title !== title || Number(order.amount_minor) !== chargedAmountMinor || order.product_id !== selectedProduct.productId) {
          return sendError(409, 'This checkout request key was already used for different purchase details.');
        }
        if (order.checkout_url) return res.json({ checkoutUrl: order.checkout_url, sessionId: order.session_id, checkoutMode: order.metadata?.checkout_mode || 'redirect' });
        if (!['creating', 'checkout_error'].includes(order.status)) return sendError(409, 'This purchase already has a checkout attempt. Please contact support.');
      } else {
        const orderId = uuid();
        const row = {
          order_id: orderId, request_key: requestKey, video_id: video?.id || null,
          bundle: isBundle, title, amount_minor: chargedAmountMinor, currency: 'usd',
          product_id: selectedProduct.productId, status: 'creating',
          metadata: {
            video_id: video?.id || null, title, bundle: isBundle ? 'all' : null,
            static_catalog_purchase: staticCatalogPurchase,
            requested_amount_minor: requestedAmountMinor,
            owner_hash: owner,
            checkout_request: {
              productId: selectedProduct.productId, orderId, customerRef: orderId,
              successUrl: `${c.appOrigin}/payment/success`, cancelUrl: `${c.appOrigin}/payment/cancel?requestKey=${requestKey}`,
              checkoutMode: 'embedded',
              ...(c.strictTest && c.environment === 'test' ? { domainMode: 'strict' } : {}),
              ...(c.variablePricing ? { amount: chargedAmountMinor, currency: 'usd' } : {}),
              metadata: { video_id: video?.id || '', title, bundle: isBundle ? 'all' : '' },
            },
          },
        };
        ({ data: order, error } = await supabase.from('walled_orders').insert(row).select('*').single());
        if (error) {
          if (error.code === '23505') return sendError(409, 'Checkout is already being created. Please retry shortly.');
          throw error;
        }
      }

      const payload = order.metadata?.checkout_request || {
        productId: selectedProduct.productId,
        orderId: order.order_id,
        customerRef: order.order_id,
        successUrl: `${c.appOrigin}/payment/success`,
        cancelUrl: `${c.appOrigin}/payment/cancel`,
        ...(c.variablePricing ? { amount: requestedAmountMinor, currency: 'usd' } : {}),
        metadata: { video_id: video?.id || '', title, bundle: isBundle ? 'all' : '' },
      };
      const response = await fetch(`${c.baseUrl}/checkout/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': order.order_id },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        await supabase.from('walled_orders').update({ status: 'checkout_error', last_error: `HTTP ${response.status}` }).eq('order_id', order.order_id);
        let providerDetail = [
          typeof result.error === 'string' ? result.error : '',
          result.error?.code,
          result.error?.message,
          result.code,
          result.message,
          result.detail,
        ].filter((value) => typeof value === 'string' && value.trim())
          .join(' | ').replace(/\s+/g, ' ').slice(0, 500);
        for (const secret of [c.apiKey, c.webhookSecret].filter(Boolean)) providerDetail = providerDetail.split(secret).join('[redacted]');
        console.error('Walled checkout session failed:', {
          status: response.status,
          detail: providerDetail || 'No error details returned',
        });
        return sendError(502, 'Walled could not create this checkout. Check the product setup and try again.');
      }
      if (typeof result.checkoutUrl !== 'string' || !/^https:\/\//i.test(result.checkoutUrl) || !result.sessionId) {
        return sendError(502, 'Walled returned an invalid checkout session.');
      }
      let checkoutUrl;
      try {
        checkoutUrl = new URL(result.checkoutUrl);
        if (checkoutUrl.origin !== new URL(c.checkoutOrigin).origin || checkoutUrl.username || checkoutUrl.password) throw new Error();
      } catch { return sendError(502, 'Walled returned an unexpected checkout address.'); }
      const checkoutMode = result.checkoutMode || (payload.checkoutMode === 'embedded' ? '' : 'redirect');
      if (!['embedded', 'redirect'].includes(checkoutMode)) return sendError(502, 'Walled did not confirm how this checkout must open.');
      if (result.orderId !== order.order_id || result.productId !== selectedProduct.productId
        || result.customerRef && result.customerRef !== order.order_id
        || Number(result.amount) !== chargedAmountMinor || String(result.currency).toLowerCase() !== 'usd') {
        await supabase.from('walled_orders').update({
          session_id: result.sessionId, status: 'checkout_error', last_error: 'Walled session does not match the stored order.',
        }).eq('order_id', order.order_id);
        console.error('Walled checkout blocked because the returned session did not match the order.');
        return sendError(409, 'The Walled payment details do not match this purchase.');
      }
      const checkoutEnvironment = String(result.environment || '').toLowerCase();
      if ((process.env.NODE_ENV !== 'production' || c.environment === 'test') && !['test', 'development'].includes(checkoutEnvironment)
        || c.environment === 'production' && !['production', 'live'].includes(checkoutEnvironment)) {
        await supabase.from('walled_orders').update({ status: 'checkout_error', last_error: 'Non-development session blocked locally.' }).eq('order_id', order.order_id);
        console.error('Walled checkout blocked locally because the API key did not create a Development session.');
        return sendError(409, 'This local checkout was blocked because Walled did not confirm Development mode.');
      }
      const { error: saveError } = await supabase.from('walled_orders').update({
        session_id: result.sessionId, checkout_url: result.checkoutUrl,
        status: result.status || 'pending', environment: result.environment || null,
        metadata: { ...order.metadata, checkout_mode: checkoutMode },
      }).eq('order_id', order.order_id);
      if (saveError) throw saveError;
      return res.json({ checkoutUrl: checkoutUrl.href, sessionId: result.sessionId, checkoutMode });
    } catch (error) {
      console.error('Walled checkout error:', error?.message || error);
      return sendError(error.status || 500, error.status ? error.message : 'Could not start checkout. Please try again.');
    }
  };

  app.post('/api/walled-checkout', startCheckout);
  app.get(['/checkout', '/api/walled-checkout'], reviewCheckout);

  app.get('/payment/success', (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Payment status</title>
<style>
  * { box-sizing: border-box; } [hidden] { display: none !important; }
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: #fafafa; background: #09090b; }
  main { max-width: 36rem; margin: 10vh auto; padding: 1.5rem; }
  h1 { line-height: 1.2; } p { color: #c4c4ce; }
  label { display: block; margin-bottom: .5rem; font-weight: 600; }
  input { width: 100%; min-height: 46px; padding: .7rem; border: 1px solid #444; border-radius: 8px; background: #18181b; color: #fff; font: inherit; font-size: .9rem; }
  button { margin-top: .6rem; min-height: 44px; padding: .6rem 1rem; border: 1px solid #555; border-radius: 8px; background: #27272a; color: #fff; font: inherit; cursor: pointer; }
  #delivery { display: block; margin-top: 1.2rem; padding: .8rem 1rem; border-radius: 10px; text-align: center; color: #191919; background: #ffd04a; font-weight: 700; text-decoration: none; }
  a { color: #b4b7ff; }
</style></head><body><main><h1 id="payment-heading">Checking your payment</h1><p id="status" role="status" aria-live="polite">Your payment is being confirmed. This may take a moment.</p>
<div id="content-link-wrap" hidden><label for="content-link">Your content link</label><input id="content-link" type="text" readonly><button id="copy-content-link" type="button">Copy link</button></div>
<a id="delivery" hidden target="_blank" rel="noopener noreferrer">Get your content</a><p>Keep your payment reference for support.</p></main><script src="/js/payment-success.js"></script></body></html>`);
  });
  app.get('/payment/cancel', async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    try {
      const db = req.app.locals.getSupabase?.();
      const key = orderKey(req);
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
      if (db && (key || sessionId)) {
        const { data: order, error } = await db.from('walled_orders').select('*').eq(key ? 'request_key' : 'session_id', key || sessionId).maybeSingle();
        if (!error && order && ownsCheckout(order, checkoutOwner(req, res))) {
          const params = new URLSearchParams({ requestKey: order.request_key, cancelled: '1' });
          if (order.video_id) params.set('video_id', order.video_id);
          else if (order.bundle) params.set('bundle', 'true');
          else params.set('product_name', order.title);
          return res.redirect(303, '/checkout?' + params);
        }
      }
    } catch { /* Cancellation is navigation only; do not modify the order. */ }
    return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment page closed</title><main style="font:16px/1.6 system-ui;max-width:34rem;margin:15vh auto;padding:24px"><h1>Payment page closed</h1><p>Return to the page where you started your purchase to continue. If you completed payment, use your payment confirmation to check its status.</p></main>');
  });

  app.get('/api/walled-status', async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    const c = config();
    if (!isConfigured(c)) return res.status(503).json({ error: 'Walled checkout is not configured.' });
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId || sessionId.length > 100) return res.status(400).json({ error: 'Invalid payment reference.' });
    try {
      const supabase = req.app.locals.getSupabase?.();
      if (!supabase) return res.status(503).json({ error: 'Payment status is unavailable.' });
      const { data: order, error } = await supabase.from('walled_orders').select('*').eq('session_id', sessionId).maybeSingle();
      if (error) throw error;
      if (!order) return res.status(404).json({ error: 'Payment reference not found.' });
      if (!ownsCheckout(order, checkoutOwner(req, res))) return res.status(403).json({ error: 'This purchase belongs to another checkout session.' });
      const response = await fetch(`${c.baseUrl}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
      });
      const current = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ error: 'Could not verify payment status.' });
      if (current.orderId !== order.order_id || current.productId !== order.product_id || current.sessionId !== order.session_id
        || current.customerRef && current.customerRef !== order.order_id
        || Number(current.amount) !== Number(order.amount_minor) || String(current.currency).toLowerCase() !== order.currency
        || (order.environment && current.environment !== order.environment)) {
        return res.status(409).json({ error: 'Payment details do not match this order.' });
      }
      if (['refunded', 'disputed', 'dispute_lost'].includes(order.status)) {
        return res.json({ status: order.status });
      }
      const status = await applyPaymentState(supabase, order, current, recordWalledPurchase);
      if (current.status !== 'paid' || status !== 'paid') {
        return res.json({ status: current.status !== 'paid' ? current.status : status });
      }
      if (['test', 'development'].includes(String(current.environment || order.environment || '').toLowerCase())) {
        return res.json({ status: 'paid', test: true, title: order.title, amount: Number(order.amount_minor) / 100, currency: String(order.currency).toUpperCase() });
      }
      const delivery = await resolveOrderDelivery(order, { getVideoForCheckout, getTelegramUsername });
      return res.json({
        status,
        title: order.title,
        amount: Number(order.amount_minor) / 100,
        currency: String(order.currency || 'usd').toUpperCase(),
        ...delivery,
      });
    } catch (error) {
      console.error('Walled status lookup failed:', error?.message || error);
      return res.status(500).json({ error: 'Could not verify payment status.' });
    }
  });

  app.post('/api/webhooks/walled', async (req, res) => {
    const c = config();
    if (!c.webhookSecret) return res.status(503).send('Webhook is not configured.');
    if (!signatureIsValid(req.rawBody, req.get('Walled-Signature'), c.webhookSecret)) return res.status(400).send('Invalid signature.');
    let event;
    try { event = JSON.parse(req.rawBody.toString('utf8')); } catch { return res.status(400).send('Invalid JSON.'); }
    if (!event?.id || !ALLOWED_EVENTS.has(event.type) || !event.data) return res.status(400).send('Invalid event.');
    const supabase = req.app.locals.getSupabase?.();
    if (!supabase) return res.status(503).send('Storage unavailable.');
    try {
      const { data: prior, error: priorError } = await supabase.from('walled_webhook_events').select('event_id, processed_at').eq('event_id', event.id).maybeSingle();
      if (priorError) throw priorError;
      if (prior?.processed_at) return res.sendStatus(200);
      if (!prior) {
        const { error } = await supabase.from('walled_webhook_events').insert({ event_id: event.id, event_type: event.type, payload: event });
        if (error && error.code !== '23505') throw error;
      }
      const data = event.data;
      const { data: order, error } = await supabase.from('walled_orders').select('*').eq('order_id', data.orderId).maybeSingle();
      if (error) throw error;
      if (!order || data.productId !== order.product_id || data.sessionId !== order.session_id || data.customerRef && data.customerRef !== order.order_id || data.amount !== Number(order.amount_minor) || String(data.currency).toLowerCase() !== order.currency || !data.environment || (order.environment && data.environment !== order.environment)) {
        throw new Error('Walled event does not match a stored order.');
      }
      const statusResponse = await fetch(`${c.baseUrl}/checkout/sessions/${encodeURIComponent(order.session_id)}`, {
        headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
      });
      const current = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(`Walled status reconciliation failed (${statusResponse.status}).`);
      await applyPaymentState(supabase, order, current, recordWalledPurchase);
      const { error: markError } = await supabase.from('walled_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
      if (markError) throw markError;
      return res.sendStatus(200);
    } catch (error) {
      console.error('Walled webhook processing failed:', error?.message || error);
      return res.status(500).send('Event processing failed.');
    }
  });
}

async function applyPaymentState(supabase, order, payment, recordPurchase) {
  const statuses = new Set(['pending', 'failed', 'paid', 'expired', 'refunded', 'partially_refunded', 'disputed', 'dispute_lost']);
  const status = String(payment.status || '').toLowerCase();
  if (!statuses.has(status)) throw new Error('Unsupported Walled payment status.');
  if (payment.orderId !== order.order_id || payment.productId !== order.product_id || payment.sessionId !== order.session_id
    || payment.customerRef && payment.customerRef !== order.order_id
    || Number(payment.amount) !== Number(order.amount_minor) || String(payment.currency).toLowerCase() !== order.currency
    || (order.environment && payment.environment !== order.environment)) {
    throw new Error('Walled payment status does not match the stored order.');
  }
  const terminal = new Set(['refunded', 'disputed', 'dispute_lost']);
  if (terminal.has(order.status) && status !== order.status) return order.status;
  if (order.status === 'paid' && ['pending', 'failed', 'expired'].includes(status)) return order.status;
  if (status === 'paid' && order.status !== 'paid' && !['test', 'development'].includes(String(payment.environment || order.environment || '').toLowerCase())) {
    if (typeof recordPurchase !== 'function') throw new Error('Walled purchase recorder is unavailable.');
    const result = await recordPurchase(payment, order);
    if (!result?.ok) throw new Error('Could not persist the confirmed Walled purchase.');
  }
  const { data: updated, error } = await supabase.from('walled_orders').update({
    status, walled_status: status, transaction_id: payment.transactionId || order.transaction_id,
  }).eq('order_id', order.order_id).eq('status', order.status).select('order_id').maybeSingle();
  if (error) throw error;
  if (!updated) {
    const { data: latest, error: reloadError } = await supabase.from('walled_orders').select('status').eq('order_id', order.order_id).maybeSingle();
    if (reloadError) throw reloadError;
    if (latest?.status === 'paid' && ['pending', 'failed', 'expired'].includes(status)) return latest.status;
    if (terminal.has(latest?.status)) return latest.status;
    throw new Error('Walled order changed while processing; retry reconciliation.');
  }
  return status;
}
