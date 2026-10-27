import { readFileSync } from 'node:fs';

// The merchant's server-side storefront is the source of catalog titles/prices.
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const decode = value => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const entries = [...html.matchAll(/<div class="card" data-name="([^"]+)" data-price="([^"]+)">([\s\S]*?)(?=<div class="card"|<\/section>)/g)]
  .map(match => ({
    title: decode(match[3].match(/<div class="card-title">([^<]+)<\/div>/)?.[1] || match[1]),
    alias: decode(match[1]), amount: Number(match[2]),
  }));
entries.push({ title: 'ALL EBooks Promo', amount: 100, alias: 'All Content Promo' });
entries.push({ title: 'Complete Digital Library - All 17 Ebooks', amount: 150, alias: 'Complete Digital Library' });

export function findCatalogPurchase(input) {
  const name = String(input.product_name || input.display_title || '').trim();
  const item = entries.find(entry => entry.title === name || entry.alias === name);
  return item && Number.isFinite(item.amount) && item.amount > 0 ? item : null;
}

// Ebook gateways are whatever IDs are currently configured for the ebook store.
// Product IDs that were renamed in Walled and moved to WALLED_VIDEO_FIXED_PRODUCTS_JSON
// are therefore accepted for videos; an ID present in both maps is still refused.
function configuredEbookIds() {
  const ids = new Set();
  try {
    const map = JSON.parse(String(process.env.WALLED_FIXED_PRODUCTS_JSON || '').trim() || '{}');
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const id of Object.values(map)) if (String(id || '').trim()) ids.add(String(id).trim());
    }
  } catch { /* invalid JSON means no ebook gateways are configured */ }
  const single = String(process.env.WALLED_PRODUCT_ID || '').trim();
  if (single) ids.add(single);
  return ids;
}

export function knownEbookGateway(productId) { return configuredEbookIds().has(String(productId || '').trim()); }
export function gatewayName(productId, configuredNames = {}) {
  return String(configuredNames[productId] || '').trim();
}
