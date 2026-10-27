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

export function renderCheckoutPage(purchase, input, requestKey, cancelled = false) {
  const data = JSON.stringify({ input, requestKey }).replace(/</g, '\\u003c');
  const label = purchase.checkoutName;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Secure payment</title><link rel="stylesheet" href="/css/checkout.css"></head>
<body><header><span class="brand">Secure</span><span class="header-note">Protected payment</span></header>
<main><section class="intro"><p class="eyebrow">COMPLETE YOUR PURCHASE</p><h1>One more step.<br><span>Pay with confidence.</span></h1><p>Review your purchase, then continue to the secure payment form below.</p></section>
<div class="checkout-grid"><section class="summary" aria-label="Order summary"><span class="section-label">YOUR ORDER</span><h2>${escape(purchase.title)}</h2><div class="total"><span>Total</span><strong>${escape(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(purchase.amount))}</strong></div>
${label ? `<div class="notice"><h3>Product name in the payment form</h3><p>The Walled payment form will show:</p><strong>${escape(label)}</strong><p>Your purchase remains the item shown in this order summary.</p></div>` : ''}
<p class="delivery-note">Access is provided after payment confirmation. Keep your payment reference if you need assistance.</p></section>
<section class="payment" aria-label="Payment"><span class="section-label">PAYMENT</span><h2>Ready to continue?</h2><p>Your payment details are entered directly in the Walled payment form.</p><button id="pay-button" type="button">Pay securely · ${escape(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(purchase.amount))}</button><p id="checkout-status" role="status" aria-live="polite">${cancelled ? 'You returned from the payment form. Continue to check or complete your payment.' : ''}</p><div id="walled-checkout"></div><p class="payment-footnote">Content is released only after the payment is verified.</p></section></div></main>
<footer>Secure payment powered by Walled</footer><script id="checkout-data" type="application/json">${data}</script><script src="/js/checkout.js" defer></script></body></html>`;
}
