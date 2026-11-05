# BigKitchen Cloudflare Worker

Safety default: `DRY_RUN = "true"`. The Worker validates Shopify webhook HMAC,
looks up the product linked to the changed Inventory Item, sums `available`
across the product's variants and inventory levels, and returns a preview.
It does NOT change product status while DRY_RUN is true.

## Cloudflare build settings
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

## Cloudflare Worker Secrets
Add these as Secrets in Worker Settings > Variables and Secrets:
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Never commit `.env`, client secrets, access tokens, or credentials to GitHub.

## Webhook
Endpoint after deploy: `/webhooks/inventory-levels-update`
Shopify topic: `inventory_levels/update`

Register the webhook only after the Worker is deployed and its URL is known.
Keep DRY_RUN true until end-to-end webhook previews are verified.

## Important limitations before LIVE
This starter has no persistent webhook-id deduplication/audit database.
It currently fetches up to 250 variants and 250 inventory levels per variant.
Add durable deduplication and pagination before enabling unattended live updates.
