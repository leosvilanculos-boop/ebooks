(function () {
  var data = JSON.parse(document.getElementById('checkout-data').textContent);
  var button = document.getElementById('pay-button');
  var status = document.getElementById('checkout-status');
  var mounted = null;
  var pending = false;
  var session = null;
  var verificationPending = false;

  function validCheckout(value) {
    var url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid checkout address.');
    return url;
  }

  async function verifyPayment(expectedSessionId) {
    if (verificationPending) return;
    verificationPending = true;
    try {
      var response = await fetch('/api/walled-status?sessionId=' + encodeURIComponent(expectedSessionId), { cache: 'no-store', credentials: 'same-origin' });
      var result = await response.json();
      if (response.ok && result.status === 'paid') {
        window.location.assign('/payment/success?sessionId=' + encodeURIComponent(expectedSessionId));
      } else if (response.ok && ['failed', 'expired', 'refunded', 'disputed', 'dispute_lost'].indexOf(result.status) !== -1) {
        status.textContent = 'Payment status: ' + result.status + '. Please contact the store if you need help.';
      } else {
        status.textContent = 'Verifying payment… keep this page open.';
      }
    } catch (error) { status.textContent = 'We could not verify payment yet. Keep your payment reference and try again shortly.'; }
    finally { verificationPending = false; }
  }

  function loadSdk(origin) {
    if (window.WalledGateway) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = origin + '/walled-gateway.js';
      script.onload = function () { window.WalledGateway ? resolve() : reject(new Error('Payment form is unavailable.')); };
      script.onerror = function () { script.remove(); reject(new Error('Payment form could not load. Please try again.')); };
      document.head.appendChild(script);
    });
  }

  async function startPayment() {
    if (pending || mounted) return;
    pending = true;
    button.disabled = true;
    status.textContent = 'Loading payment…';
    try {
      if (!session) {
        var response = await fetch('/api/walled-checkout', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, data.input, { requestKey: data.requestKey })),
        });
        var result = await response.json();
        if (!response.ok) throw new Error(response.status >= 500 ? 'This payment is temporarily unavailable. Please contact the store.' : result.error || 'Payment could not be started. Please try again.');
        session = result;
      }
      var checkoutUrl = validCheckout(session.checkoutUrl);
      if (session.checkoutMode === 'redirect') {
        status.textContent = 'Opening the payment form…';
        window.location.assign(checkoutUrl.href);
        return;
      }
      if (session.checkoutMode !== 'embedded' || !session.sessionId) throw new Error('Payment form configuration is unavailable.');
      await loadSdk(checkoutUrl.origin);
      mounted = window.WalledGateway.mount({
        container: '#walled-checkout', checkoutUrl: checkoutUrl.href,
        onResult: function (message) {
          // The browser event is only a hint; always ask our server to verify payment.
          if (message && message.sessionId === session.sessionId) verifyPayment(session.sessionId);
        },
      });
      status.textContent = '';
      button.hidden = true;
    } catch (error) {
      status.textContent = error.message || 'Payment could not be started. Please try again.';
      button.hidden = false;
      button.disabled = false;
    } finally { pending = false; }
  }
  button.addEventListener('click', startPayment);
  if (data.autoStart) startPayment();
  window.addEventListener('pagehide', function () { if (mounted && typeof mounted.destroy === 'function') mounted.destroy(); });
})();
