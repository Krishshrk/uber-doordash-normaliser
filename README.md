# Marketplace Order System

Uber Eats and DoorDash orders normalised into one internal kitchen ticket.

---

## Demo

[▶ Watch demo](https://drive.google.com/file/d/10zp-FlYpJyHTasLuuW6E87Fn_emWdqUU/view?usp=sharing)

---

## Run instructions

### Prerequisites
- Node.js ≥ 18
- npm ≥ 9

### 1. Start the API

```bash
cd api
npm install
npm run dev
# API listens on http://localhost:3001
```

On first start the API seeds 5 demo orders (2 Uber, 3 DoorDash) so the admin has data immediately.

### 2. Start the admin

```bash
cd admin
npm install
npm run dev
# Admin at http://localhost:5173
```

### Environment variables (api/.env)

```
UBER_CLIENT_SECRET=       # HMAC key for X-Uber-Signature verification
UBER_ACCESS_TOKEN=        # OAuth Bearer token for GET /v2/eats/order/{id}
UBER_API_BASE=            # Override Uber API base URL (e.g. local mock); default https://api.uber.com
DOORDASH_WEBHOOK_AUTH=    # Auth token for DoorDash webhook Authorization header
```

All are optional in dev — auth is skipped when the variable is unset, so fixture curls work without credentials.

---

## Curl examples

### Uber Eats webhook

The Uber webhook is a thin notification. It carries only IDs; the full order is fetched separately via Get Order.

```bash
# With signature (production)
SIG=$(openssl dgst -sha256 -hmac "$UBER_CLIENT_SECRET" -r \
  fixtures/uber/webhook-orders-notification.json | cut -d' ' -f1)

curl -i -X POST http://localhost:3001/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-Environment: sandbox" \
  -H "X-Uber-Signature: $SIG" \
  --data-binary @fixtures/uber/webhook-orders-notification.json

# Dev (no UBER_CLIENT_SECRET set — auth skipped)
curl -X POST http://localhost:3001/api/webhook \
  -H "Content-Type: application/json" \
  -d @fixtures/uber/webhook-orders-notification.json
```

Real response:

```
HTTP/1.1 200 OK
Content-Length: 0
```

Empty body, 200 — per Uber docs. Anything else triggers retries (7 total, exponential backoff).

Without `UBER_ACCESS_TOKEN` the API synthesises a minimal order from the webhook IDs (dev fallback). Set `UBER_ACCESS_TOKEN` and optionally `UBER_API_BASE` to point at a local mock to trigger the real Get Order fetch.

Run twice, the second run updates the same row, not a duplicate.

### DoorDash Marketplace webhook

```bash
# With auth token (production)
curl -X POST http://localhost:3001/api/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: $DOORDASH_WEBHOOK_AUTH" \
  -d @fixtures/doordash/webhook-order-create.json

# Dev (no DOORDASH_WEBHOOK_AUTH set — auth skipped)
curl -X POST http://localhost:3001/api/webhook \
  -H "Content-Type: application/json" \
  -d @fixtures/doordash/webhook-order-create.json
```

Real response:

```
HTTP/1.1 202 Accepted
Content-Length: 0
```

202 = async confirm mode. 200 would mean synchronously accepted at DoorDash — see conflicts log item B.

Run twice — the second run updates the same row, not a duplicate.

### Advance an order status

```bash
curl -X PATCH http://localhost:3001/api/orders/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"accepted"}'
```

Real response:

```json
{"ok":true}
```

Valid statuses: `new → accepted → ready → completed`. Terminal exits: `canceled`, `rejected`. Moves backward or from a terminal state return 400.

### List all orders

```bash
curl http://localhost:3001/api/orders
```

Real response (seeded demo data):

```json
[
  {
    "id": "72f03168-33cc-4e57-a265-52535fee7a4c",
    "provider": "doordash",
    "external_order_id": "dd-order-001",
    "status": "new",
    "customer": "Carol T",
    "line_items": [
      { "name": "Burrito Bowl",  "quantity": 1, "unit_price_cents": 1200 },
      { "name": "Chips & Guac", "quantity": 1, "unit_price_cents":  650 }
    ],
    "total_cents": 1850,
    "currency": "USD",
    "created_at": "2026-10-05T19:58:40.257Z",
    "raw_payload": { "..." : "..." }
  },
  {
    "id": "9c58bcdf-575b-4a92-a234-2834dfc042f2",
    "provider": "uber",
    "external_order_id": "uber-order-001",
    "status": "accepted",
    "customer": "Alice M",
    "line_items": [
      { "name": "Margherita Pizza", "quantity": 1, "unit_price_cents": 1299 },
      { "name": "Garlic Bread",     "quantity": 2, "unit_price_cents":  399 }
    ],
    "total_cents": 2097,
    "currency": "USD",
    "created_at": "2026-10-05T19:54:40.246Z",
    "raw_payload": { "..." : "..." }
  }
]
```

---

## Field mapping table

### Uber Eats (Get Order response → internal model)

| Internal field | Uber field | Notes |
|---|---|---|
| `external_order_id` | `order.id` | UUID; equals webhook `meta.resource_id`. Log if they differ (§9 item 7) |
| `status` | `order.current_state` | CREATED→new, ACCEPTED→accepted, FINISHED→completed, DENIED→rejected, CANCELED→canceled, UNKNOWN→new (logged) |
| `customer` | `order.eater.first_name` + `order.eater.last_name` | Docs: last_name is initial only |
| `line_items[].name` | `order.cart.items[].title` | |
| `line_items[].quantity` | `order.cart.items[].quantity` | |
| `line_items[].unit_price_cents` | `order.cart.items[].price.unit_price.amount` | Integer minor units |
| `total_cents` | `order.payment.charges.total.amount` | Includes tax and fees paid to merchant; excludes MFT taxes Uber remits |
| `currency` | `order.payment.charges.total.currency_code` | |
| `created_at` | `order.placed_at` | ISO 8601 with fixed local offset |
| `raw_payload` | `{ webhook body, order }` | Stored for dispute/debug |

### DoorDash Marketplace (webhook order object → internal model)

| Internal field | DoorDash field | Notes |
|---|---|---|
| `external_order_id` | `order.id` | Needed for PATCH confirm call |
| `status` | `event.status` | Only `NEW` documented → mapped to `new` |
| `customer` | `order.consumer.first_name` + `order.consumer.last_name` | `consumer.id` is 64-bit int |
| `line_items[].name` | `order.categories[].items[].name` | Items nested under categories |
| `line_items[].quantity` | `order.categories[].items[].quantity` | |
| `line_items[].unit_price_cents` | `order.categories[].items[].price` + Σ `extras[].options[].price × quantity` | Integer minor units assumed |
| `total_cents` | `order.subtotal + order.tax` | Our rule see conflicts log item 3 |
| `currency` | *(not in payload)* | Hardcoded `USD` see conflicts log item C |
| `created_at` | *(not in payload)* | Webhook receipt time see conflicts log item C |
| `raw_payload` | Full webhook body | Stored for dispute/debug |

---

## Conflicts log

| # | Working note | Verdict | Deciding source |
|---|---|---|---|
| 1 | Uber webhook may include the full cart; maybe no Get Order needed | **Rejected.** Webhook has only `event_id`, `event_time`, `meta`, `resource_href`. Get Order is required | Uber Order Notification page |
| 2 | DoorDash line items may be top-level `items[]` | **Rejected.** Items live at `categories[].items[]` | DoorDash Order model; Sample order |
| 3 | Which DoorDash field is `total_cents`; tax included? | **Changed.** No `total` field exists. Fields: `subtotal`, `tax`, `tip_amount`, `merchant_tip_amount`. Our rule: `subtotal + tax`; tips excluded. Units assumed cents (sample values consistent). Uber is different: `payment.charges.total` already includes tax | DoorDash Order model |
| 4 | Verify Uber signature | **Verified.** Lowercase hex HMAC-SHA256 over raw body bytes, client secret as key, header `X-Uber-Signature`. Docs say "SHA256 hash" in table but HMAC in text — use HMAC | Uber Order Notification |
| 5 | Exact Uber response | **Verified.** `200`, empty body. Anything else triggers retries (7 total, exponential backoff) | Uber Order Notification |
| 6 | DoorDash Drive webhooks are optional | **Rejected as irrelevant.** Drive is a separate product. For Marketplace, the Orders webhook is required | DoorDash "Create a webhook subscription" |
| 7 | Uber `meta.resource_id` = Get Order `id` | **Verified in text** but official examples use different IDs. Key on the fetched order's `id`; log a warning if it differs from `resource_id` | Uber Order Notification vs Get Order example |
| 8 | Don't rely on a `provider` query param | **Verified.** Both payloads are self-describing | Both webhook docs |
| 9 | Location of DoorDash customer phone | **Verified:** `consumer.phone`. Default is a DoorDash support number; masked number only if enabled | DoorDash masked phone guide |
| 10 | Normalize statuses | **Verified with caveat.** Uber has a documented enum; DoorDash only has `NEW` on the webhook | Uber Get Order; DoorDash order integration |
| A | DoorDash webhook auth scheme | **Not published.** Docs say "authentication token" without specifying the header format. Implemented as `Authorization: <token>` compared to `DOORDASH_WEBHOOK_AUTH`. Verify in Developer Portal before production | DoorDash "Create a webhook subscription" |
| B | DoorDash response code | **Changed from 200 to 202.** `200` = synchronously accepted (order confirmed). `202` = async confirm later (we PATCH separately). Returning `200` would immediately confirm the order at DoorDash | DoorDash order integration §3.4 |
| C | DoorDash currency and created_at | **Not in payload.** No `currency` field (hardcoded `USD`) and no `created_at` field (webhook receipt time used). Verify currency against DoorDash Order model reference before multi-currency support | DoorDash Order model |

---

## Architecture notes

- **Single webhook endpoint** (`POST /api/webhook`) handles both providers. Provider is detected from payload shape, not a URL parameter.
- **Uber flow**: webhook → verify HMAC → respond 200 empty → fetch full order via Get Order API → upsert.
- **DoorDash flow**: webhook IS the full order → verify auth → upsert → respond 202 (async confirm mode).
- **Upsert key**: `(provider, external_order_id)` — same marketplace order received again updates in place.
- **Uber dedup**: `event_id` stored in a separate table; duplicate deliveries skip the Get Order fetch entirely.
- **DoorDash dedup**: handled by the upsert UNIQUE constraint on `(provider, external_order_id)`.
- **Uber unknown event types**: ack'd 200 and ignored; only `orders.notification` and `orders.scheduled.notification` create rows.
- **Storage**: SQLite via sql.js (pure JS, no native build required). DB file written to `api/orders.db`.
- **Money**: always stored and transmitted as integer minor units (cents). Formatted to currency string only in the UI.
- **Status**: internal set is `new → accepted → ready → completed`; `canceled` and `rejected` are terminal exits. Forward-only enforced in the API.
