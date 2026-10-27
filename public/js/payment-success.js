(function () {
  var sessionId = new URLSearchParams(window.location.search).get('sessionId') || '';
  var status = document.getElementById('status');
  var delivery = document.getElementById('delivery');
  var content = document.getElementById('content-link-wrap');
  var input = document.getElementById('content-link');
  var copy = document.getElementById('copy-content-link');
  var tries = 0;

  function safeLink(value) {
    try {
      var url = new URL(String(value || '').trim());
      return /^(https?:)$/.test(url.protocol) ? url.href : '';
    } catch (error) { return ''; }
  }

  copy.addEventListener('click', async function () {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(input.value);
      } else {
        input.select();
        if (!document.execCommand('copy')) throw new Error('copy');
      }
      copy.textContent = 'Copied';
    } catch (error) {
      input.focus();
      input.select();
      copy.textContent = 'Select and copy the link';
    }
  });

  async function check() {
    if (!sessionId) {
      status.textContent = 'Payment reference is missing. Please contact support.';
      return;
    }
    try {
      var response = await fetch('/api/walled-status?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
      var result = await response.json();
      if (response.ok && result.status === 'paid') {
        if (result.test) {
          document.getElementById('payment-heading').textContent = 'Test payment confirmed';
          status.textContent = 'Your Development payment was verified. No live purchase or content access was created.';
          return;
        }
        document.getElementById('payment-heading').textContent = 'Payment confirmed';
        var productLink = safeLink(result.product_link);
        if (productLink) {
          status.textContent = 'Your content is ready. Open or copy your access link below.';
          input.value = productLink;
          content.hidden = false;
          delivery.href = productLink;
          delivery.textContent = 'Open your content';
          delivery.hidden = false;
          return;
        }
        var user = String(result.telegram_username || '').replace(/^@/, '').trim();
        if (user) {
          var lines = [
            'Hello, I just paid for ' + (result.title || 'my purchase') + '.',
            'Amount: ' + result.amount + ' ' + result.currency + '.',
            'Payment reference: ' + sessionId + '.',
            'Please send me access to my purchase.'
          ].join('\n');
          status.textContent = 'Payment confirmed. Use the Telegram button below to get your content.';
          delivery.href = 'https://t.me/' + encodeURIComponent(user) + '?text=' + encodeURIComponent(lines);
          delivery.textContent = 'Get your content on Telegram';
          delivery.hidden = false;
        } else {
          status.textContent = 'Payment confirmed. Please contact the store for your access link.';
        }
        return;
      }
      if (response.ok && ['refunded', 'disputed', 'dispute_lost', 'failed', 'expired'].includes(result.status)) {
        status.textContent = 'Payment status: ' + result.status + '. Please contact support if you need help.';
        return;
      }
    } catch (error) { /* Retry while the provider confirms payment. */ }
    if (++tries < 8) setTimeout(check, 2500);
    else status.textContent = 'Payment is still being confirmed. Refresh this page shortly or contact support.';
  }

  return check();
})();
