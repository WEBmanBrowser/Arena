# MD Tech Solutions — Deployment Guide

## Architecture

```
Browser → loja.mdtech.pt → Cloudflare Workers (Next.js via OpenNext)
                                    ↓
                          Cloudflare Hyperdrive
                                    ↓
                          Neon PostgreSQL
```

## Stack

- **Runtime**: Next.js 16.3 on Cloudflare Workers via @opennextjs/cloudflare
- **Database**: PostgreSQL on Neon, connected via Cloudflare Hyperdrive
- **ORM**: Drizzle ORM
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **Styling**: Tailwind CSS 4

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL and JWT_SECRET

# 3. Push schema to database
npm run db:push

# 4. Seed demo data (optional)
npm run db:seed

# 5. Start dev server
npm run dev
```

## Cloudflare Deployment

### 1. Create Neon Database

1. Create project at [neon.tech](https://neon.tech)
2. Note connection string: `postgres://user:pass@ep-xxx.neon.tech/dbname`

### 2. Push Schema to Neon

```bash
DATABASE_URL="postgres://user:pass@ep-xxx.neon.tech/dbname?sslmode=require" npm run db:push
```

### 3. Create Hyperdrive

```bash
npx wrangler login
npx wrangler hyperdrive create mdtech-neon-db \
  --connection-string="postgres://user:pass@ep-xxx.neon.tech/dbname"
```

Update `wrangler.jsonc` with the returned Hyperdrive ID.

### 4. Set Secrets

```bash
npx wrangler secret put JWT_SECRET
```

### 5. Build & Deploy

```bash
npm run build:cloudflare
npm run deploy
```

### 6. Custom Domain

In Cloudflare Dashboard → Workers → mdtech-loja → Settings → Custom Domains → Add `loja.mdtech.pt`

## Environment Variables

### Required (secrets — set via `wrangler secret put`)

| Variable | Description |
|---|---|
| `JWT_SECRET` | JWT signing key (min 32 chars) |

### Optional (secrets)

| Variable | Description |
|---|---|
| `EMAIL_API_KEY` | Resend API key for transactional emails |
| `EMAIL_FROM` | Sender address |

### Cloudflare Bindings (wrangler.jsonc)

| Binding | Type | Description |
|---|---|---|
| `HYPERDRIVE` | Hyperdrive | Neon PostgreSQL connection |
| `ASSETS` | Assets | Static file serving |

## Price Convention

All `product.price` values are **GROSS** (IVA included). This is B2C Portugal standard.

- Net = Gross / (1 + VAT rate)
- VAT = Gross - Net
- Example: 123.00€ gross at 23% → Net 100.00€, VAT 23.00€

## Database Schema

23+ tables including: users, products, categories, brands, orders, order_items, payments, coupons, stock_movements, order_status_history, rma_requests, reviews, banners, blog_posts, settings, pages, wishlists, audit_logs, email_notifications, shipping_methods, smart_shopping_profiles, pc_builder_rules.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Local Next.js dev server |
| `npm run build` | Standard Next.js build |
| `npm run build:cloudflare` | Build for Cloudflare Workers |
| `npm run preview:cloudflare` | Test Workers build locally |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run db:push` | Push schema to database |
| `npm run db:seed` | Seed demo data |
| `npm test` | Run automated tests (vitest) |

## Automatic Reservation Expiry (Cron Trigger)

### How it works

Orders in `pending_payment` status have a `reservationExpiresAt` timestamp set at creation time (default: 60 minutes from creation, configurable via `ORDER_RESERVATION_MINUTES` environment variable).

A Cloudflare Cron Trigger runs every 10 minutes and calls `releaseExpiredReservations()`, which:

1. Finds all orders with `status = pending_payment` AND `reservationExpiresAt <= NOW()`
2. For each expired order (inside a transaction):
   - Releases reserved stock back to available
   - Sets order status to `expired`
   - Sets payment status to `expired`
   - Decrements coupon usage if applicable
   - Creates inventory movements
   - Creates order status history
   - Sends expiry notification email (if configured)
3. The operation is fully idempotent — running it twice has no additional effect

### Architecture

```
Cloudflare Cron Trigger (*/10 * * * *)
  → custom-worker.ts scheduled() handler
    → self-fetch to POST /api/cron/expire-reservations (protected by CRON_SECRET)
      → releaseExpiredReservations()
```

The `custom-worker.ts` file wraps the OpenNext-generated worker and adds the `scheduled()` handler required by Cloudflare. See [OpenNext Custom Worker docs](https://opennext.js.org/cloudflare/howtos/custom-worker).

### Configuration

| Setting | Default | How to change |
|---|---|---|
| Reservation duration | 60 minutes | Set `ORDER_RESERVATION_MINUTES` env var |
| Cron frequency | Every 10 min | Edit `triggers.crons` in `wrangler.jsonc` |
| Cron secret | **Required** — `CRON_SECRET` only (no `JWT_SECRET` fallback; cron fails closed without it) | Set `CRON_SECRET` via `wrangler secret put` |

### Cron expression

In `wrangler.jsonc`:
```jsonc
"triggers": {
  "crons": ["*/10 * * * *"]
}
```

**All Cloudflare Cron times are in UTC.**

### Testing locally

```bash
# Start wrangler dev with scheduled handler test support
npx wrangler dev --test-scheduled

# In another terminal, trigger the scheduled handler
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

### Testing the endpoint manually

```bash
# Call the protected API route directly (requires CRON_SECRET — JWT_SECRET never authorizes cron)
curl -X POST https://loja.mdtech.pt/api/cron/expire-reservations \
  -H "x-cron-secret: YOUR_SECRET"
```

### Verifying in Cloudflare Dashboard

1. Go to Workers & Pages → `mdtech-loja` → Settings → Triggers
2. Under "Cron Triggers", verify `*/10 * * * *` is listed
3. Check "Past Cron Events" for execution history and status

### Changing reservation duration

```bash
# Set to 30 minutes instead of default 60
npx wrangler secret put ORDER_RESERVATION_MINUTES
# Enter: 30
```

## Product Images / Cloudflare R2

### Setup

1. Create R2 bucket:
```bash
npx wrangler r2 bucket create mdtech-product-images
```

2. The `wrangler.jsonc` already contains the binding:
```jsonc
"r2_buckets": [{ "binding": "PRODUCT_IMAGES", "bucket_name": "mdtech-product-images" }]
```

3. Configure a custom/public domain for the bucket in Cloudflare Dashboard → R2 → mdtech-product-images → Settings → Custom Domains

4. Set the public URL:
```bash
npx wrangler secret put R2_PUBLIC_URL
# Enter: https://img.mdtech.pt (your R2 custom domain)
```

### Behavior

- **R2 not configured**: Upload returns `STORAGE_NOT_CONFIGURED (503)`. Product editing works normally without images.
- **R2 configured but no public URL**: Images upload successfully but `publicUrl` will be `null`. Admin sees "URL pública não configurada".
- **Fully configured**: Images have public URLs and display in store and admin.

### Local development

R2 bindings are not available in local `npm run dev`. Image upload will return `STORAGE_NOT_CONFIGURED`. Use `npx wrangler dev` for R2 testing.

## Bulk Pricing Secret

### Setup

```bash
# Generate a secure random secret (min 32 characters)
openssl rand -base64 32

# Set as Cloudflare secret
npx wrangler secret put BULK_PREVIEW_SECRET
```

Bulk pricing preview/apply requires this secret for HMAC-signed tokens. Without it, bulk price operations return `BULK_PREVIEW_SECRET_NOT_CONFIGURED`.
