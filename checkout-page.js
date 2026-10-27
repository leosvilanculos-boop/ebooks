import crypto from 'node:crypto';

const COOKIE = 'secure_checkout_owner';
export function checkoutOwner(req, res, create = false) {
  let token = String(req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  if (!/^[a-f0-9]{64}$/.test(token)) {
    if (!create) return '';
    token = crypto.randomBytes(32).toString('hex');
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function ownsCheckout(order, owner) {
  const expected = order?.metadata?.owner_hash;
  // Historical orders use their unguessable session URL as the access capability.
  if (!expected) return true;
  if (!owner || expected.length !== owner.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(owner));
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function renderCheckoutPage(purchase, input, requestKey, cancelled = false, review = true) {
  const data = JSON.stringify({ input, requestKey, autoStart: !review }).replace(/</g, '\\u003c');
  const label = purchase.checkoutName;
  const price = escape(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(purchase.amount));
  if (!review) return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Secure payment</title><link rel="stylesheet" href="/css/checkout.css"></head>
<body class="checkout-direct"><header><span class="brand">Secure</span></header><main><section class="payment" aria-label="Payment"><h1>Complete your payment</h1><div class="direct-order"><h2>${escape(purchase.title)}</h2><strong>${price}</strong></div><button id="pay-button" type="button" hidden>Try again</button><p id="checkout-status" role="status" aria-live="polite">Loading payment…</p><div id="walled-checkout"></div><p class="payment-footnote">Access after payment confirmation.</p></section></main><footer>Powered by Walled</footer><script id="checkout-data" type="application/json">${data}</script><script src="/js/checkout.js" defer></script></body></html>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Secure payment</title><link rel="stylesheet" href="/css/checkout.css"></head>
<body><header><span class="brand">Secure</span></header>
<main><section class="intro"><h1>Checkout</h1></section>
<div class="checkout-grid"><section class="summary" aria-label="Order summary"><span class="section-label">YOUR ORDER</span><h2>${escape(purchase.title)}</h2><div class="total"><span>Total</span><strong>${price}</strong></div>
${label ? `<p class="notice">Shown on the payment form as <strong>${escape(label)}</strong></p>` : ''}</section>
<section class="payment" aria-label="Payment"><button id="pay-button" type="button">Pay securely · ${price}</button><p id="checkout-status" role="status" aria-live="polite">${cancelled ? 'Payment not completed. Try again below.' : ''}</p><div id="walled-checkout"></div></section></div></main>
<footer>Powered by Walled</footer><script id="checkout-data" type="application/json">${data}</script><script src="/js/checkout.js" defer></script></body></html>`;
}
