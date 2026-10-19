# Secure checkout site

The storefront and checkout live on this service. All checkout buttons and legacy payment URLs create a Walled checkout session directly; the buyer does not need a second pay button on an intermediate page.

## Environment

Configure these values in the secure site's deployment environment:

- `WALLED_API_BASE_URL`: the Walled Integrations API base URL, including `/api/v1/integrations`.
- `WALLED_APP_ORIGIN`: this service's public HTTPS origin, with no trailing slash.
- `WALLED_API_KEY`: server-side API key for the same Walled environment as the webhook.
- `WALLED_PRODUCT_ID`: Walled product UUID when variable pricing is enabled.
- `WALLED_VARIABLE_PRICING=true`: enable only when that Walled product supports variable pricing. Video prices are read from Supabase on the server.
- `WALLED_FIXED_PRODUCTS_JSON`: for fixed-price mode, a JSON object mapping exact USD prices to Walled product UUIDs. Include the secure storefront's catalog amounts and the $200 library offer, plus main-store video prices when using fixed-price mode.
- `WALLED_ALLOWED_PRICES_USD`: comma-separated exact secure storefront catalog prices when using a variable-pricing product. The secure catalog will reject any amount not listed here.
- `WALLED_WEBHOOK_SECRET`: signing secret for the Walled webhook.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: server-only credentials for the same Supabase project as the main video store. The secure service reads video prices and records Walled orders, webhook events, and confirmed purchases.
- `TELEGRAM_USERNAME`: optional support username shown after payment confirmation.

Do not put server keys in browser variables or commit them. Apply `../videos-site-main/sql/walled-checkout.sql` to the shared Supabase project before enabling Walled checkout.

## Walled configuration

In Walled, allow the secure service hostname only. Set the success URL to `https://secure.example.com/payment/success`, the cancellation URL to `https://secure.example.com/payment/cancel`, and the webhook URL to `https://secure.example.com/api/webhooks/walled`. Replace `secure.example.com` with the hostname used in `WALLED_APP_ORIGIN`.

On the main video site, set `EBOOKS_SITE_URL` to the same secure HTTPS origin. Its purchase buttons send the video ID and an idempotency key to the secure service; the secure server looks up the real title and price in Supabase and redirects straight to Walled.

## Checkout endpoints

- `GET /api/walled-checkout`: starts a Walled session for a video, library bundle, or configured secure-store catalog item and redirects directly to Walled.
- `POST /api/walled-checkout`: JSON checkout endpoint retained for integrations that need a JSON response.
- `GET /api/walled-status`: reconciles a session with Walled.
- `POST /api/webhooks/walled`: validates and processes signed Walled events idempotently.
- Legacy payment checkout URLs remain compatible but route to Walled. Legacy direct charge and FX/link endpoints are disabled.
- `GET /api/health`: reports whether Supabase and Walled settings are present.
