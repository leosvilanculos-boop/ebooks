# Secure checkout site

The main store's Pay button opens `/checkout/review` on Secure. Only this main-store flow shows the confidence screen, selected purchase, server-calculated total, confirmed Walled product name when available, and an additional Pay button. It does not open the ebook catalog or create a payment session merely by loading the review page. Old links to `/checkout` with a main-store item identity retain the review behavior.

Purchases initiated in Secure's ebook catalog open `/checkout`. This compact payment page starts session creation and the Walled integration automatically, without the confidence screen or another Pay click. If loading fails, a retry button appears. The existing product IDs remain unchanged.

The payment script posts to the Secure server after the main-store review button or automatically for Secure catalog purchases. The server reads `checkoutMode` from Walled's response; it does not send this response-only field in the request, because the published `CreateGatewayCheckoutIn` schema rejects it with HTTP 422. The browser loads `/walled-gateway.js` from the exact origin of the returned checkout URL and calls `WalledGateway.mount()` for embedded sessions. An explicit legacy `checkoutMode: "redirect"` response retains the existing redirect flow until Walled migrates that gateway. Missing or unknown modes are rejected.

## Environment

Configure these values in the secure site's deployment environment:

The current deployment uses fixed pricing. `.env.example` contains placeholders; the existing `.env.txt` is a private deployment file and must not be published or included in public archives. Import its settings into the hosting environment; Node's default dotenv loader reads `.env`, not `.env.txt`. The host supplies `PORT` automatically. Ebook titles and prices come from the server-owned catalog in `public/index.html`; browser prices and display titles are not trusted.

- `NODE_ENV=production`: required for live Walled sessions on the deployed service; local development should use Development credentials and a non-production environment.
- `WALLED_API_BASE_URL`: the Walled Integrations API base URL, including `/api/v1/integrations`.
- `WALLED_APP_ORIGIN`: this service's public HTTPS origin, with no trailing slash.
- `WALLED_CHECKOUT_ORIGIN`: exact checkout/SDK origin, currently `https://trywalled.com`. It is distinct from the API origin.
- `WALLED_ENVIRONMENT`: `test` or `production`, matching the API key. Returned session environments are checked.
- `WALLED_STRICT_TEST_MODE`: set `true` only with `WALLED_ENVIRONMENT=test` and Development credentials on the allowed HTTPS domain. New requests then include `domainMode: "strict"`. Set `false` in Production; the live request omits this test-only field.
- `WALLED_API_KEY`: server-side API key for the same Walled environment as the webhook.
- `WALLED_PRODUCT_ID`: Walled product UUID when variable pricing is enabled.
- `WALLED_VARIABLE_PRICING=false`: the current mode uses the exact product mapping. Set to `true` only when switching to a product that supports variable pricing. Video prices are read from Supabase on the server.
- `WALLED_FIXED_PRODUCTS_JSON`: exact ebook prices mapped to their Walled product UUIDs, including the $100 ALL EBooks Promo offer. Family Comfort Food Recipes is $50.
- `WALLED_VIDEO_FIXED_PRODUCTS_JSON`: optional separate mapping for the main store's video products. Use gateways registered for the actual content. A video order cannot reuse a known ebook gateway under another product name.
- `WALLED_CHECKOUT_NAMES_JSON`: optional object mapping gateway UUIDs to their actual names in Walled. Confirmed ebook names are also read from `WALLED_PRODUCT_UPDATES.json`. The notice refers to the payment form; it does not invent a privacy alias or a bank statement descriptor.
- `WALLED_VIDEO_BUNDLE_PRODUCT_ID`: a separate Walled product for the main store's video bundle. The previous $100 product now sells ALL EBooks Promo and must not be reused for the video bundle. Until a separate video bundle product is configured, new video bundle checkouts return an unavailable response; existing confirmed purchases can still be delivered.
- `WALLED_ALLOWED_PRICES_USD`: comma-separated exact secure storefront catalog prices when using a variable-pricing product. The secure catalog will reject any amount not listed here.
- `WALLED_WEBHOOK_SECRET`: signing secret for the Walled webhook.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: server-only credentials for the same Supabase project as the main video store. The secure service reads video prices and records Walled orders, webhook events, and confirmed purchases.
- `TELEGRAM_USERNAME`: ebook support username, defaulting to `sweet1books`. Shown in the storefront and used for ebook delivery after payment confirmation.

Do not put server keys in browser variables or commit them. Apply `../videos-site-main/sql/walled-checkout.sql` to the shared Supabase project before enabling Walled checkout.

## Walled configuration

In Walled, allow `ebooks-repo.up.railway.app`, with no scheme, port, path or wildcard. Domains are shared across Development and Production. The success URL is `https://ebooks-repo.up.railway.app/payment/success`, cancellation base URL is `https://ebooks-repo.up.railway.app/payment/cancel`, and webhook URL is `https://ebooks-repo.up.railway.app/api/webhooks/walled`. Connect the webhook in each environment to its matching signing secret. New requests include the stored request key in the cancellation URL to resume the same checkout.

On the main site, set `EBOOKS_SITE_URL` to the same secure HTTPS origin. Its purchase buttons send only the item identity and an idempotency key. Secure looks up the actual title and price in Supabase before showing the dedicated payment page. Deploy both projects together and configure matching main-store gateways before enabling those purchases.

## Checkout endpoints

- `GET /checkout/review`: main-store order review, product-name notice and explicit Pay button.
- `GET /checkout`: Secure catalog payment page; its browser script automatically starts the payment integration. Main-store item identities retain review behavior for compatibility.
- `GET /api/walled-checkout`: compatibility alias which selects the appropriate flow from the validated purchase identity.
- `POST /api/walled-checkout`: creates an order and session, returning `checkoutUrl`, `sessionId`, and `checkoutMode`. New guest orders require their owner cookie and a same-origin request.
- `GET /api/walled-status`: reconciles a session with Walled.
- `POST /api/webhooks/walled`: validates and processes signed Walled events idempotently.
- Legacy payment URLs remain compatible but reach the Secure review page. Direct charge and FX/link endpoints are disabled.
- `GET /api/health`: reports whether Supabase and Walled settings are present.

## Content delivery after payment

After Walled confirms the stored order as paid, `/api/walled-status` reads the purchased video's `product_link` from the shared Supabase project. The confirmation screen displays that link with open and copy actions. Missing or invalid video links fall back to a Telegram button using `site_config.telegram_username`, the same setting managed in the main site's admin panel. For videos, `TELEGRAM_USERNAME` is used only if that shared setting is empty. Video bundle purchases also use the shared Telegram contact. Ebook catalog purchases and the complete ebook library use `TELEGRAM_USERNAME` (`sweet1books` by default), independently of the video store's contact.

Delivery data is not returned for pending, mismatched or revoked payments. Payment responses are private and not cached. Development payments exercise confirmation without inserting live purchase ledger records or returning real content links. Deploy all source modules and the checkout CSS/JavaScript assets together.

## Strict-mode migration and validation

Keep existing IDs, keys and webhook connections. A product awaiting review still needs to be regularized through Walled's review process.

1. Deploy on the allowed HTTPS domain with Development credentials, `WALLED_ENVIRONMENT=test`, and `WALLED_STRICT_TEST_MODE=true`.
2. For each gateway, create a fresh order and complete the embedded Development payment. Verify the signed webhook or server lookup, cancellation, and card authentication/3DS where applicable. A sample notification acknowledgment or a local mocked test does not qualify as a Walled end-to-end test.
3. Only after a successful embedded test from the preceding 30 days and merchant confirmation should Walled activate strict mode for that gateway. Do not automatically send the confirmation email or enable strict mode.
4. In Production, use the live credentials, `WALLED_ENVIRONMENT=production`, and `WALLED_STRICT_TEST_MODE=false`.

The exact provider request is persisted before calling Walled. Retries reuse its order ID, request key, payload and mode. New guest orders store an owner-cookie hash; another browser cannot retrieve their checkout or delivery data. Historical orders retain their existing session-reference access behavior. The purchases table must retain its unique `transaction_id` constraint for durable fulfillment deduplication. No additional order columns are needed; the existing JSON metadata stores ownership, the provider request and checkout mode.

Previously rejected requests whose stored error is HTTP 422 can remove the unsupported `checkoutMode` request field while retaining the same product ID, merchant order and idempotency key. Accepted or uncertain requests are not rewritten. Structured validation paths/messages are logged and stored without rejected input values, authorization headers or secrets. This compatibility correction was checked against `https://api.trywalled.com/openapi.json` on 2026-10-27.

SDK `onResult` callbacks and return URLs are navigation hints only. The browser always asks the server to verify payment. Raw-body signature verification, event deduplication, status reconciliation, and terminal-state safeguards remain in the webhook handler.

Run `npm run test:checkout` here and in the main-store project. Tests use mocked provider responses and never contact a live payment provider. A real hosted Development checkout and signed confirmation remain required before declaring the strict-mode migration complete.
