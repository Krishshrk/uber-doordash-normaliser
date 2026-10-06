# Fixtures

Official examples, minimally repaired. Every change from the published source is listed here.

## uber/webhook-orders-notification.json

Source: Uber Order Notification webhook docs.
No repairs needed — the published example is valid JSON.

## uber/get-order-response.json

Source: Uber Get Order Details docs.
Repairs made:
- The published example is **not valid JSON** (trailing commas after several fields). Trailing commas removed.
- `...` placeholder strings replaced with representative values.
- `taxInfo` / `tax_info` inconsistency noted in §2.4 of the guide; fixture uses `tax_info` (schema form).

## doordash/webhook-order-create.json

Source: DoorDash "Receive orders from DoorDash" + Sample order docs.
The webhook envelope (`event` + `order`) and the sample order are on separate pages; combined here.
Repairs made:
- The published sample is missing a comma after `"tax": 300` — fixed.
- `consumer.id` is a 64-bit integer (`9007199254740993`) — kept as-is; JSON parsers that
  use IEEE 754 doubles will lose precision. Use a BigInt-aware parser in production.
- `tip_amount` is documented as self-delivery only; kept in fixture as it appears in the sample.
- No `currency` field in the sample — confirmed absent; `USD` is hardcoded in the normaliser.
- No `created_at` field — confirmed absent; webhook receipt time is used instead.
