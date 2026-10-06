# Uber Eats & DoorDash Order Integration Guide

Parts 1–4 cover the four original sources (Uber Order Notification webhook, Uber Get Order Details, DoorDash Receive orders, DoorDash Sample order). **Revision 2** adds Part 5 (corrections from further research) and Parts 6–10 for the ingest-API project: endpoint design, internal model and mapping table, status normalization, a conflicts log, fixtures/curl and admin notes. Where sources disagree, official docs win and the disagreement is logged in §9.

---

## 1. At a glance

|  | **Uber Eats** | **DoorDash Marketplace** |
| --- | --- | --- |
| Notification | `POST` to your URI, `event_type: orders.notification` | `POST` to your URL, `event.type: OrderCreate`, `status: NEW` |
| What the webhook carries | **Thin**: IDs plus `resource_href`. You must `GET` the order | **Full order** object in the payload |
| Fetch order | `GET https://api.uber.com/v2/eats/order/{order_id}` | Not needed (already in payload) |
| Auth on inbound webhook | `X-Uber-Signature` (HMAC-SHA256, client secret) | Auth token configured per webhook in the Developer Portal; exact header scheme not published (§9 item A) |
| Auth on your outbound calls | OAuth 2.0 Bearer, scope `eats.order` or `eats.store.orders.read` | Not covered on these pages |
| Acknowledge receipt | HTTP 200, **empty body** | Sync: HTTP 200 = success, non-2xx = failure. Async: HTTP 202 |
| Accept / deny | `POST /v1/eats/orders/{order_id}/accept_pos_order` or `/deny_pos_order` within **11.5 min** | `PATCH /api/v1/orders/{id}` within **3–8 min** (async) |
| Retries | Exponential backoff, 7 total attempts | Not stated on these pages |
| Order key | `meta.resource_id` = `order_id` (UUID) | `order.id` (keep it; needed for PATCH) |
| Money format | Integer minor units + `currency_code` | Integers in sample (`subtotal: 2000`); units not stated on the fetched pages |

---

## 2. Uber Eats

> Access may require written approval from Uber. APIs are subject to Uber's versioning and upgrade policy.

### 2.1 Flow

1. Uber `POST`s `orders.notification` to your webhook.
2. You verify the signature, return **200 with an empty body**, and enqueue the work.
3. You `GET` the order using `resource_href` (or `meta.resource_id`).
4. You `POST /accept_pos_order` or `/deny_pos_order` within **11.5 minutes**, otherwise the order times out and **auto-cancels**.

Speed matters: accept as fast as possible to reduce eater cancellations. If the store has robocalls enabled, a call fires if there is no accept/deny after **90 seconds**.

### 2.2 Webhook

**Headers**

| Header | Meaning |
| --- | --- |
| `X-Environment` | `production` or `sandbox` |
| `X-Uber-Signature` | Lowercase hex HMAC-SHA256 of the raw request body, keyed with your **client secret** |

**Verification (Python, from the docs)**

```python
digester = hmac.new(client_secret, webhook_body, hashlib.sha256)
expected = digester.hexdigest()   # compare to X-Uber-Signature (use hmac.compare_digest)
```

Sign the **raw bytes** of the body, before any JSON parsing or re-serialisation.

**Payload**

| Field | Type | Notes |
| --- | --- | --- |
| `event_type` | string | `orders.notification` |
| `event_id` | string | Unique. **Dedupe on this**: retries happen and order is not guaranteed |
| `event_time` | integer | Unix timestamp |
| `meta.user_id` | string | The location (`store_id`) the event is for |
| `meta.resource_id` | string | Equals `order_id` |
| `meta.status` | string | Documented value: `pos` |
| `resource_href` | string | Full GET URL for the order |

```json
{
  "event_type": "orders.notification",
  "event_id": "c4d2261e-2779-4eb6-beb0-cb41235c751e",
  "event_time": 1427343990,
  "meta": {
    "resource_id": "153dd7f1-339d-4619-940c-418943c14636",
    "status": "pos",
    "user_id": "89dd9741-66b5-4bb4-b216-a813f3b21b4f"
  },
  "resource_href": "https://api.uber.com/v2/eats/order/153dd7f1-339d-4619-940c-418943c14636"
}
```

### 2.3 Get Order Details

`GET https://api.uber.com/v2/eats/order/{order_id}`

- **Auth:** OAuth 2.0 Bearer with `eats.order` **or** `eats.store.orders.read`.
- **Compression:** the response can be very large. Send `Accept-Encoding: gzip`.
- **Path param:** `order_id` (UUID).

**Top-level fields**

| Field | Req | Notes |
| --- | --- | --- |
| `id` | ✔ | Order UUID |
| `display_id` | ✔ | Last 5 chars of `id`; what staff and couriers see |
| `external_reference_id` |  | Your own order ID, if you supplied one on accept |
| `current_state` | ✔ | `CREATED`, `ACCEPTED`, `DENIED`, `FINISHED`, `CANCELED`, `UNKNOWN` |
| `type` | ✔ | `PICK_UP`, `DINE_IN`, `DELIVERY_BY_UBER` (default), `DELIVERY_BY_RESTAURANT` (other types enabled only by Uber) |
| `brand` | ✔ | `UBER_EATS` or `POSTMATES`; use this, not `type`, to tell brands apart |
| `store` |  | `id`, `name`, `integrator_store_id`, `integrator_brand_id`, `merchant_store_id` / `external_reference_id` |
| `eater` | ✔ | `first_name`, last initial, anonymised `phone` + `phone_code` |
| `eaters[]` |  | Group-order participants; link to items via `eater_id` |
| `cart` | ✔ | Items, order-level instructions, fulfillment issues |
| `payment` | ✔ | `charges`, `accounting`, `promotions` |
| `packaging` |  | `disposable_items.should_include` (null = merchant's discretion) |
| `placed_at` / `estimated_ready_for_pickup_at` |  | ISO 8601 with fixed local offset; the ready time is a prediction |
| `deliveries[]` | ✔ | Uber courier details; populated once a courier is scheduled |
| `order_manager_client_id` |  | May be masked; compare with your client ID |

**Cart items**

- `id` is the *store's* item ID. `instance_id` is *Uber's* ID for the cart line. Use `instance_id` to match fulfillment issues and tax lines.
- `selected_modifier_groups[]` contain `selected_items` and `removed_items` (removed = a default option the eater deselected).
- `special_instructions` (item level) may contain **allergy information**. If you can't handle it, set `disable_item_instructions: true` in your menu upload.
- `special_requests.allergy` (structured allergens: `DAIRY`, `EGGS`, `FISH`, `SHELLFISH`, `TREENUTS`, `PEANUTS`, `GLUTEN`, `SOY`, `OTHER` + `freeform_text`) is off by default and enabled by Uber.
- `fulfillment_action`: eater's out-of-item preference: `REPLACE_FOR_ME`, `SUBSTITUTE_ME`, `CANCEL`, `REMOVE_ITEM`.
- `cart.fulfillment_issues[]`: `OUT_OF_ITEM` / `PARTIAL_AVAILABILITY`, with `root_item`, `item_availability_info` (`items_requested` / `items_available`) and optional `item_substitute`.

**Money object:** `{ "amount": 350, "currency_code": "USD", "formatted_amount": "$3.50" }`. `amount` is an integer in the smallest currency unit.

**`payment.charges`:** `total`, `sub_total`, `tax`, `total_fee`, `total_fee_tax`, `bag_fee`, `pick_and_pack_fee`. For merchant delivery only: `delivery_fee`(+tax), `small_order_fee`(+tax), `tip`, `cash_amount_due`, `marketplace_fee_due_to_uber`. Where Marketplace Facilitator laws apply, `total` excludes taxes Uber remits.

**Fields that need enabling by Uber (absent by default):** `payment.promotions` and the `*_promo_applied` charges, item-level `discount_amount_applied`, `accounting.tax_reporting`, item `tax_info.labels`, order-level `cart.special_instructions`, allergy requests. Code defensively: **do not assume these exist**.

**Merchant-delivery-only objects:** `eater.delivery` (`location`, `type`: `DELIVER_TO_DOOR` / `CURBSIDE` / `LEAVE_AT_DOOR`, `notes`).

**Courier (`deliveries[]`):** `current_state` is `SCHEDULED`, `EN_ROUTE_TO_PICKUP`, `ARRIVED_AT_PICKUP`, `EN_ROUTE_TO_DROPOFF`, `COMPLETED` or `FAILED`. Name, vehicle, photo and phone appear only once a courier is en route. Autonomous vehicles add `handoff_instructions` and `passcode`.

**Taiwan-only:** `corporate_tax_id_taiwan`, `tax_profile` (mobile barcode, citizen digital certificate, donation code).

### 2.4 Uber documentation inconsistencies to be aware of

The reference page's example and its schema disagree in places. Treat the **schema tables** as intended and validate against a real sandbox payload:

- The example is **not valid JSON** (trailing commas).
- `taxInfo` appears inside `price` for some items and at item level for others; the schema defines `tax_info` at item level.
- Example `accounting` uses camelCase (`taxRemittance`, `currencyCode`); the schema uses snake_case (`tax_remittance`, `total_fee_tax`, `currency_code`).
- One `gross_amount` is `3.27`, a decimal, though amounts are documented as integers.
- Tax line items use `calculated_tax` in the example but `tax_amount` in the schema.
- The signature header is described as a "SHA256 hash" in the table but as an **HMAC** in the text. Use HMAC.

---

## 3. DoorDash Marketplace

> Marketplace APIs are limited access; apply through the DoorDash Developer Portal.

### 3.1 Flow

1. DoorDash `POST`s an `OrderCreate` event (status `NEW`) containing the **full order**.
2. You respond either **synchronously** (HTTP 200 = accepted; non-2xx = failed) or **asynchronously** (HTTP 202, then confirm later).
3. If async, call `PATCH /api/v1/orders/{id}` with `success` or `fail`.
4. Optionally signal readiness, handle Auto Order Release, and cancel post-confirmation (see 3.5).

The webhook URL can match your menu-status URL or be separate. **Configuration is manual: contact DoorDash.**

### 3.2 Webhook payload

```json
{ "event": { "type": "OrderCreate", "status": "NEW" }, "order": { "...Order object..." } }
```

Persist `order.id`: it is the path parameter for confirmation.

**Notable fields**

| Field | Notes |
| --- | --- |
| `special_instructions` | Item-level; the store can disable or cap length |
| `is_tax_remitted_by_doordash` / `tax_amount_remitted_by_doordash` | Marketplace Facilitator states: DoorDash remits tax |
| `estimated_pickup_time` | Dasher ETA; used if you don't send `prep_time` |
| `delivery_short_code` | Short identifier shown in the Dasher app for pickup |
| `fulfillment_type` | Dasher delivery, merchant (self) delivery, or customer pickup (sample: `dx_delivery`) |
| `experience` | DoorDash, Caviar or Storefront |
| `merchant_tip_amount` | Tip left for staff |
| `consumer.id` | **Must support 64-bit integers** |

### 3.3 Sample order (structure)

The sample is one *Burrito Scram-Bowl* with *Ketchup* and *Salt*.

```
order
├─ id, store{merchant_supplied_id, provider_type}
├─ consumer{id, first_name, last_name, phone, email}
├─ categories[]  →  items[]  →  extras[]  →  options[]  →  extra[] (nested)
│    each node: merchant_supplied_id, name, price, quantity
├─ subtotal, tax, tip_amount, merchant_tip_amount
├─ is_pickup, estimated_pickup_time (UTC), order_special_instructions
├─ is_tax_remitted_by_doordash, tax_amount_remitted_by_doordash
└─ commission_type, delivery_short_code, fulfillment_type, experience,
   is_plastic_ware_option_selected
```

**Parsing notes:** modifiers nest recursively (`options[].extra[].options[]`), so use a recursive parser, not a fixed depth. Match your own catalog via `merchant_supplied_id`. The sample JSON has a missing comma after `"tax": 300`, so don't copy-paste it as a fixture without fixing that. A separate *Sample self-delivery order* exists in DoorDash's reference.

### 3.4 Confirming an order: `PATCH /api/v1/orders/{id}`

| Mode | How | Limits |
| --- | --- | --- |
| **Synchronous** | Reply to the webhook call: 200 = success; any non-2xx = failure. Body shape = async payload | HTTP timeout is just over 1 min, but prefer async if it regularly takes more than \~20 s |
| **Asynchronous** | Reply **202**, then `PATCH` success/fail later | Confirm within **3–8 min** (varies per order) or DoorDash marks it failed with a confirmation timeout |

**Request body**

```json
{
  "merchant_supplied_id": "your order id",
  "order_status": "success",
  "prep_time": "2026-10-06T14:30:00Z",
  "failure_reason": "…",
  "errors": [{ "code": "ITEM_OUT_OF_STOCK", "merchant_supplied_id": "item_id_123", "message": "Item is currently unavailable" }]
}
```

- `order_status`: `success` or `fail`. `prep_time` is optional, **UTC**, and should only be sent if you have your own prep logic. **Never echo back DoorDash's `estimated_pickup_time`** (it inflates prep estimates). Scheduled orders ignore prep time (pickup targets 10 min before the drop-off window).
- Sending your internal ID in `merchant_supplied_id` makes DoorDash store it as `client_order_id`, which is returned in Auto Order Release events.

**PATCH responses:** `202` accepted · `400` bad format / already confirmed / timed out · `404` order ID not found · `500` internal error.

**Failure reasons (always send `failure_reason` on `fail`)**

| Theme | Required text |
| --- | --- |
| Hours wrong | `Store Unavailable - Hours out of Sync` |
| Closed / remodel | `Store Unavailable - Closed or Remodel` |
| POS offline | `Store Unavailable - Connectivity Issue` |
| Capacity throttle | `[Store Name] is experiencing high order volume and cannot prepare your order for [order placed time]` |
| Stale pickup time | `Pickup time sent in the order is no longer available.` |
| Ordering disabled | `Store is disabled for online ordering. Store must be enabled to receive orders.` |
| Item 86'd | `Item Unavailable - [Item Name] - [Item ID] - Out of stock` |
| Time-bound item | `Item Unavailable - [Item Name] - [Item ID] - This item is not being served at this time` |
| Item missing | `Item Missing - [Item Name] - [Item ID] - This item is no longer on the Menu` |
| Price mismatch | `Pricing Mismatch - [Item Name] - [Item ID]` |
| Misconfigured store | `Store is misconfigured with incorrect integration ID` |

**Structured `errors[]` codes** (each error needs `code`, `merchant_supplied_id`, `message`): `INVALID_ORDER`, `ITEM_OUT_OF_STOCK`, `STORE_HOURS_ISSUE`, `INTERNAL_ERROR`, `OTHER`, `CONNECTIVITY_ISSUE`, `TIME_OUT`, `STORE_CLOSED`, `STORE_CLOSED_EARLY`, `POS_OFFLINE`, `CAPACITY_THROTTLING`, `STALE_PICKUP_TIME`, `ORDER_ONLINE_DISABLED`, `INVALID_ADDRESS`, `STORE_RENOVATION`, `STORE_TEMP_CLOSED`, `WEATHER_ISSUES`. Including item/modifier IDs lets DoorDash auto-correct menu availability and prevents repeat failures.

### 3.5 Other order-flow features (summary only)

- **Auto Order Release (AOR):** DoorDash holds an order and releases it to your POS when the time is right for prep. A separate call hits your configured endpoint when a Dasher is near, including vehicle info (useful for curbside).
- **Order ready signal:** merchants can tell DoorDash food is ready so Dashers are informed (see "Patch Order Events" in the Order Endpoints reference; **not covered** on the fetched pages).
- **Post-confirmation cancellation:** merchants can cancel previously accepted orders through the API instead of phoning support.

---

## 4. Implementation checklist (both platforms)

**Receive**

- [ ] Verify authenticity before parsing (Uber: HMAC over raw body; DoorDash: auth header).
- [ ] Return the acknowledgement immediately; process asynchronously via a queue.
- [ ] Idempotency: dedupe Uber on `event_id`; dedupe DoorDash on `order.id`.
- [ ] Don't rely on ordering of events.

**Decide & respond**

- [ ] Start a timer per order. Alert well before: Uber 90 s (robocall) / 11.5 min; DoorDash 3 min (lower bound of 3–8).
- [ ] Validate store open, items in stock, prices, and capacity before accepting.
- [ ] On rejection, send the **exact required reason strings** and item IDs.

**Data model**

- [ ] Store money as integer minor units + currency.
- [ ] Store `consumer.id` (DoorDash) as 64-bit.
- [ ] Parse modifiers recursively; map IDs (`id`/`instance_id` on Uber, `merchant_supplied_id` on DoorDash).
- [ ] Treat Uber's config-gated fields as optional.
- [ ] Surface allergy text to kitchen staff.

**Ops**

- [ ] Use Uber's `X-Environment` header to separate sandbox from production.
- [ ] Request gzip on Uber Get Order.
- [ ] Log raw payloads for dispute and debugging.

---

## 5. Corrections to Parts 2–3 (from extra research)

- **Uber accept:** `POST https://api.uber.com/v1/eats/orders/{order_id}/accept_pos_order`, scope `eats.order`. Optional body: `pickup_time` (Unix seconds), `external_reference_id`, `fields_relayed`. Only the store's nominated order-manager app may call it. Denied orders can still be accepted by staff in Uber Eats Orders within the 11.5-minute window.
- **Uber webhook family:** `orders.notification` (order created), `orders.scheduled.notification`, `order.fulfillment_issues.resolved`, `orders.release`, plus store events. Marketplace integrations support **one** Primary Webhook URL, so your endpoint must tolerate event types it doesn't care about (ack 200, ignore).
- **Uber auth on webhooks:** the signature is on every webhook. Uber also offers Basic Auth or OAuth on the webhook URL if configured in the dashboard.
- **DoorDash outbound auth:** calls go to `https://openapi.doordash.com/marketplace/api/v1/…` with a JWT (see DoorDash's "Create a JWT" guide). Confirm responses also include `401`, `403`, `429`. `pickup_instructions` (≤128 chars) is accepted. The ready signal is `PATCH /api/v1/orders/{id}/events/order_ready_for_pickup` and needs a **separate token**. Merchant cancel is `PATCH /api/v1/orders/{id}/cancellation` with `cancel_reason` ∈ `ITEM_OUT_OF_STOCK`, `STORE_CLOSED`, `KITCHEN_BUSY`, `OTHER`.
- **DoorDash inbound endpoints:** Orders, Menu Status and Menu Request are **required**; Order Release, Order Canceled and Dasher Status Updates are optional. HTTPS only, one endpoint per environment, protected by an auth token set in the Developer Portal.
- **DoorDash Order model (official):** `id, consumer{id,email,first_name,last_name,phone}, store, subtotal, tax, estimated_pickup_time, is_pickup, categories[], is_tax_remitted_by_doordash, tax_amount_remitted_by_doordash, commission_type (regular|dashpass), delivery_short_code, fulfillment_type (dx_delivery|pickup|mx_fleet_delivery), merchant_tip_amount, experience, is_plastic_ware_option_selected, tip_amount`. It has **no `total`, no currency and no created-at field**. Line items: `name, merchant_supplied_id, price, quantity, extras[], consumer_name, special_instructions, line_item_id`.

---

## 6. Project: ingest endpoint design

**One endpoint:** `POST /webhooks/orders`.

### 6.1 Provider detection (payload only, no `provider` field or query param)

| Provider | Signature of the payload |
| --- | --- |
| Uber | `event_type` string starting `orders.` **and** `meta.resource_id` + `resource_href` |
| DoorDash | `event.type == "OrderCreate"` **and** an `order` object |
| Neither | `400`, store nothing |

Detect first, then authenticate with that provider's scheme. Do not let a header pick the provider.

### 6.2 Authentication

|  | Check | Failure |
| --- | --- | --- |
| Uber | Lowercase-hex **HMAC-SHA256** of the **raw body bytes** keyed by the client secret must equal `X-Uber-Signature` (constant-time compare). Capture the raw body before JSON parsing | `401` |
| DoorDash | Header value must match the auth token configured for the webhook. DoorDash says the endpoint "should be protected with authentication token" and refers to "Authorization Headers/Tokens"; **the scheme isn't published** (see §9 item A) | `401` |

### 6.3 Flow and responses

|  | Flow | Success response |
| --- | --- | --- |
| **Uber** | Verify → **200, empty body** → fetch `resource_href` (Get Order) → upsert. Only `orders.notification` / `orders.scheduled.notification` create rows; other events get 200 and are ignored | `200`, no body. Anything else triggers retries (7 attempts, exponential backoff) |
| **DoorDash** | Verify → upsert from the payload (it already holds the full order) → respond | **`202`** (async confirmation, status stays `new`; confirm later via `PATCH`). A `200` would assert the order is **accepted**, and any non-2xx **fails the order** at DoorDash |

Notes:

- Uber's webhook is **not** the order; a Get Order call is required. In the demo, point the fetch at a local mock (`UBER_API_BASE`). Don't call live Uber (needs OAuth and an approved account), and only follow `resource_href` if its host is allow-listed.
- **Upsert key:** `(provider, external_order_id)` unique. Re-delivery updates the same row. Also dedupe Uber on `event_id`.

---

## 7. Internal order model and mapping

```
id, provider, external_order_id, status, customer, line_items[],
total_cents, currency, created_at, raw_payload
```

| Internal field | Uber (Get Order unless noted) | DoorDash (webhook `order`) |
| --- | --- | --- |
| `id` | generated (UUID) | generated (UUID) |
| `provider` | detected from payload | detected from payload |
| `external_order_id` | `id` (equals webhook `meta.resource_id`) | `id` |
| `status` | `current_state` → §8 | `event.status` (`NEW`) → §8 |
| `customer.name` | `eater.first_name` + `eater.last_name` (initial only) | `consumer.first_name` + `consumer.last_name` |
| `customer.phone` | `eater.phone` (+ `phone_code`), anonymised | `consumer.phone` (E.164; a DoorDash support number unless masked numbers are enabled) |
| `line_items[].name` | `cart.items[].title` | `categories[].items[].name` |
| `line_items[].quantity` | `cart.items[].quantity` | `categories[].items[].quantity` |
| `line_items[].unit_price_cents` | `price.unit_price.amount` (includes selected options) | `price` + Σ option `price × quantity` |
| `line_items[].line_total_cents` | `price.total_price.amount` | `quantity × unit_price_cents` |
| `total_cents` | `payment.charges.total.amount` | `subtotal + tax` (our rule, §9 item 3) |
| `currency` | `payment.charges.total.currency_code` | none in payload → configured default (`USD`) |
| `created_at` | `placed_at` → UTC | none in payload → webhook receipt time |
| `raw_payload` | `{webhook, order}` | full webhook body |

Money is integer minor units; format only at display time (`Intl.NumberFormat` with `currency`).

---

## 8. Status normalization

Internal: `new → accepted → ready → completed`, plus terminal `canceled` and `rejected`.

| Internal | Uber `current_state` | DoorDash |
| --- | --- | --- |
| `new` | `CREATED` | webhook `NEW`; sync/async confirmation pending |
| `accepted` | `ACCEPTED` | `PATCH` confirm with `order_status: success` |
| `ready` | no state; set via Mark Order Ready | `order_ready_for_pickup` event |
| `completed` | `FINISHED` | no state in the docs reviewed |
| `canceled` | `CANCELED` | Order Canceled webhook (not in scope) |
| `rejected` | `DENIED` | `PATCH` confirm with `order_status: fail` |
| Uber `UNKNOWN` | keep the previous status (`new` on first insert) and log |  |

In the demo, "advance status" only updates our own row. A real integration would also call `accept_pos_order` / Mark Order Ready (Uber) or the `PATCH` endpoints (DoorDash).

---

## 9. Conflicts log (working notes vs official docs)

| # | Working note | Verdict | Deciding source |
| --- | --- | --- | --- |
| 1 | Uber webhook may include the full cart; maybe no Get Order needed | **Rejected.** Webhook has only `event_id`, `event_time`, `meta`, `resource_href`. Get Order is required | Uber Order Notification page; Order Integration guide (retrieve details, then accept) |
| 2 | DoorDash line items may be top-level `items[]` | **Rejected.** Items live at `categories[].items[]` | DoorDash Order model; Sample order |
| 3 | Which DoorDash field is `total_cents`; tax included? | **Changed.** No `total` field exists. Fields: `subtotal`, `tax`, `tip_amount` (self-delivery only), `merchant_tip_amount`, `tax_amount_remitted_by_doordash`. **Our rule:** `subtotal + tax`, tips excluded, units assumed cents (docs say only "integer"; sample is 2000/300). Not official. Uber is different: `payment.charges.total` already includes tax and fees paid to the merchant | DoorDash Order model |
| 4 | Verify Uber signature | **Verified.** Lowercase hex HMAC-SHA256 over the raw body, client secret as key, header `X-Uber-Signature`. The header table says "SHA256 hash" but the text and code say HMAC; use HMAC | Uber Order Notification; Webhooks guide |
| 5 | Exact Uber response | **Verified.** `200`, empty body. No 200 → retries, 7 total | Uber Order Notification |
| 6 | DoorDash Drive webhooks are optional | **Rejected as irrelevant.** Drive is a separate product. For Marketplace, the **Orders webhook is required**; optional ones are Order Release, Order Canceled, Dasher Status | DoorDash "Create a webhook subscription" |
| 7 | Uber `meta.resource_id` = Get Order `id` | **Verified in text** ("equivalent to the order_id", `resource_href` ends with it). **But the official example IDs differ** (`153dd7f1…` vs `f9f363d1…`). Key on the fetched order's `id`; log if it differs from `resource_id` | Uber Order Notification vs Get Order example |
| 8 | Don't rely on a `provider` query param | **Verified.** Both payloads are self-describing (§6.1) | Both webhook docs |
| 9 | Location of DoorDash customer phone | **Verified:** `consumer.phone`. Default is a DoorDash support number; per-order masked number only if enabled; valid from acceptance to 30 min after completion/cancel | DoorDash masked phone number guide; FAQ |
| 10 | Normalize statuses | **Verified, with caveat:** Uber has an enum, DoorDash has no order-state enum, only `NEW` on the webhook (§8) | Uber Get Order; DoorDash order integration |

**Additional findings**

|  | Finding | Source |
| --- | --- | --- |
| A | DoorDash webhook auth scheme isn't published (only "authentication token"). A third-party AsyncAPI file claims Basic auth; **unofficial, not used**. Decision: compare the `Authorization` header to the configured token (`DOORDASH_WEBHOOK_AUTH`) | DoorDash "Create a webhook subscription" |
| B | DoorDash `200` on the webhook means **accepted**; `202` means "confirm later". We return `202` | DoorDash order integration |
| C | DoorDash payload has **no currency and no created-at**; defaulted (§7) | DoorDash Order model |
| D | Uber `UNKNOWN` state and DoorDash "completed" have no documented source for transitions | Uber Get Order |
| E | Fixtures are not valid JSON as published: Uber Get Order has trailing commas and `...` in the webhook; DoorDash sample is missing a comma after `"tax": 300`; DoorDash's envelope and order sample are separate pages. Repair minimally and say so in `fixtures/README.md` | Fixture pages |
| F | DoorDash sample items have `price: 0` but `subtotal: 2000`, so **never derive totals from line items** | DoorDash Sample order |
| G | Third-party sites list different Uber state enums (`OFFERED`, `HANDED_OFF`, …). Ignored; official enum is `CREATED/ACCEPTED/DENIED/FINISHED/CANCELED/UNKNOWN` | Uber Get Order |

---

## 10. Fixtures, curl, admin and handoff

### 10.1 Fixtures (keep webhook and Get Order separate)

```
/fixtures/uber/webhook-orders-notification.json   official webhook example
/fixtures/uber/get-order-response.json            official Get Order example (repaired JSON)
/fixtures/doordash/webhook-order-create.json      {"event":{"type":"OrderCreate","status":"NEW"},"order": <official sample order>}
/fixtures/README.md                               every repair made to the published examples
```

No `provider` field in any fixture. The mock Uber endpoint returns the Get Order fixture for any `order_id` (see §9 item 7).

### 10.2 Curl (set `UBER_CLIENT_SECRET` and `DOORDASH_WEBHOOK_AUTH` first)

```bash
# Uber: sign the exact bytes sent. Expect: HTTP 200, empty body
SIG=$(openssl dgst -sha256 -hmac "$UBER_CLIENT_SECRET" -r fixtures/uber/webhook-orders-notification.json | cut -d' ' -f1)
curl -i -X POST http://localhost:3001/webhooks/orders \
  -H "Content-Type: application/json" -H "X-Environment: sandbox" \
  -H "X-Uber-Signature: $SIG" \
  --data-binary @fixtures/uber/webhook-orders-notification.json

# DoorDash: Expect HTTP 202
curl -i -X POST http://localhost:3001/webhooks/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: $DOORDASH_WEBHOOK_AUTH" \
  --data-binary @fixtures/doordash/webhook-order-create.json
```

Run each twice: the second run must update, not duplicate (one row per `(provider, external_order_id)`).

### 10.3 Admin and API notes

- **API:** `GET /api/orders?provider=&status=&q=&sort=&cursor=&limit=` (cursor paging so the list can grow), `GET /api/orders/:id`, `POST /api/orders/:id/advance`. Index `(provider, external_order_id)` unique and `created_at`.
- **List (`/`):** Provider, External ID, Customer name, Status, Total (formatted money), Time. Filters and sort live in the query string; the detail link and "Back" preserve them. Loading, empty and error states. Rows are focusable and `Enter` opens detail. Check at 1280px and 390px.
- **Detail (`/orders/:id`):** customer, line items (name, qty, unit price, line total), status with a forward-only advance button, totals. Raw cents and marketplace JSON appear only inside a debug `<details>`. After advancing, update the cache in place (no remount).
- **Handoff:** API + admin run; both curls work; README has the mapping table (§7) and conflicts log (§9); be ready to defend: 202 vs 200 for DoorDash, `subtotal + tax`, keying on the fetched Uber `id`, and the DoorDash auth assumption.

---

## 11. Remaining gaps

- DoorDash webhook auth header scheme (confirm with DoorDash or the Developer Portal).
- DoorDash money units and whether item `price` already includes extras. **Still unstated in the Order model.** Evidence only: official sample values (`299`, `2000`, `300`) look like minor units; DoorDash consumer help says the listed price excludes optional modifiers, which fits the separate `extras[].options[].price` in the payload. Neither is an API statement, so treat both as assumptions: keep the cents conversion in one configurable place and keep `raw_payload` so totals can be recomputed. Also, menu `price` is the marketplace *delivery* price and `base_price` the *pickup* price; which one appears in an order payload isn't documented.
- Uber `deny_pos_order` request schema and the OAuth token flow (not needed for ingest).
- Uber webhook IP allow-listing.

*Sources: developer.uber.com (Order Notification, Get Order Details, Accept Order, Webhooks and Order Integration guides) and developer.doordash.com (Receive orders, Create a webhook subscription, Sample order, Marketplace API reference Order model, masked phone number guide and FAQ), retrieved 6 Oct 2026. Both vendors revise these docs; recheck before go-live.*