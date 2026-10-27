export function contentLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export async function resolveStoreTelegram(supabase, fallback = '', order = null) {
  const mainStoreOrder = !order || Boolean(order.video_id || order.bundle);
  // Contacts belong to the purchased offer, not to the shared checkout host.
  // Never send a main-store customer to the ebook store's fallback contact.
  let username = mainStoreOrder ? '' : fallback;
  if (supabase && mainStoreOrder) {
    const { data, error } = await supabase.from('site_config')
      .select('telegram_username').limit(1).maybeSingle();
    if (error) throw error;
    if (data?.telegram_username) username = data.telegram_username;
  }
  return String(username || '').trim().replace(/^@/, '');
}

// Call only after the payment provider has confirmed this stored order as paid.
export async function resolveOrderDelivery(order, { getVideoForCheckout, getTelegramUsername }) {
  const video = order.video_id && !order.bundle && typeof getVideoForCheckout === 'function'
    ? await getVideoForCheckout(order.video_id) : null;
  const productLink = contentLink(video?.product_link);
  return {
    product_link: productLink,
    delivery_via_telegram: !productLink,
    telegram_username: !productLink && typeof getTelegramUsername === 'function'
      ? await getTelegramUsername(order) : '',
  };
}
