import type { InternalOrder, LineItem, OrderStatus } from './types';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Uber current_state → internal status  (§8)
// Official enum: CREATED, ACCEPTED, DENIED, FINISHED, CANCELED, UNKNOWN
// UNKNOWN: keep previous status on update; on first insert → 'new'. Log it.
// ---------------------------------------------------------------------------
export function normaliseUberStatus(s: string): OrderStatus {
  switch (s?.toUpperCase()) {
    case 'CREATED':  return 'new';
    case 'ACCEPTED': return 'accepted';
    case 'FINISHED': return 'completed';
    case 'DENIED':   return 'rejected';
    case 'CANCELED': return 'canceled';
    case 'UNKNOWN':
      console.warn('Uber UNKNOWN state received — defaulting to new');
      return 'new';
    default:
      console.warn(`Uber unrecognised state "${s}" — defaulting to new`);
      return 'new';
  }
}

// ---------------------------------------------------------------------------
// DoorDash event.status → internal status  (§8)
// Only NEW is documented on the webhook. All other status progression is
// driven internally (manual advance or PATCH confirm).
// ---------------------------------------------------------------------------
function normaliseDoorDashStatus(s: string): OrderStatus {
  if (s?.toUpperCase() === 'NEW') return 'new';
  console.warn(`DoorDash unrecognised status "${s}" — defaulting to new`);
  return 'new';
}

// ---------------------------------------------------------------------------
// Sum extras prices for a DoorDash line item  (§7, §9 item F)
// Docs: unit_price_cents = item.price + Σ option.price × option.quantity
// Never derive order total from line items (§9 item F).
// ---------------------------------------------------------------------------
function ddItemUnitPrice(item: Record<string, unknown>): number {
  const base   = Number(item.price ?? 0);
  const extras = (item.extras as unknown[]) ?? [];
  let optionsTotal = 0;
  for (const extra of extras) {
    const e       = extra as Record<string, unknown>;
    const options = (e.options as unknown[]) ?? [];
    for (const opt of options) {
      const o = opt as Record<string, unknown>;
      optionsTotal += Number(o.price ?? 0) * Number(o.quantity ?? 1);
    }
  }
  return base + optionsTotal;
}

// ---------------------------------------------------------------------------
// Uber Get Order response → InternalOrder  (§7)
//
//   order.id                                  → external_order_id
//   order.current_state                       → status (normalised)
//   order.eater.first_name + last_name        → customer (last_name is initial only per docs)
//   order.cart.items[].title                  → line_items[].name
//   order.cart.items[].quantity               → line_items[].quantity
//   order.cart.items[].price.unit_price.amount → line_items[].unit_price_cents
//   order.payment.charges.total.amount        → total_cents (includes tax/fees)
//   order.payment.charges.total.currency_code → currency
//   order.placed_at                           → created_at
// ---------------------------------------------------------------------------
export function fromUberOrder(
  orderPayload: Record<string, unknown>,
  rawWebhook: unknown
): InternalOrder {
  const cart     = (orderPayload.cart    as Record<string, unknown>) ?? {};
  const items    = (cart.items           as unknown[])               ?? [];
  const payment  = (orderPayload.payment as Record<string, unknown>) ?? {};
  const charges  = (payment.charges      as Record<string, unknown>) ?? {};
  const total    = (charges.total        as Record<string, unknown>) ?? {};
  const eater    = (orderPayload.eater   as Record<string, unknown>) ?? {};

  const line_items: LineItem[] = items.map((i) => {
    const item      = i as Record<string, unknown>;
    const price     = (item.price      as Record<string, unknown>) ?? {};
    const unitPrice = (price.unit_price as Record<string, unknown>) ?? {};
    return {
      name:             String(item.title ?? item.name ?? ''),
      quantity:         Number(item.quantity ?? 1),
      unit_price_cents: Number(unitPrice.amount ?? 0),
    };
  });

  // §9 item 7: log if fetched order id differs from webhook meta.resource_id
  const fetchedId = String(orderPayload.id ?? '');
  const webhookMeta = (rawWebhook as Record<string, unknown>)?.meta as Record<string, unknown> | undefined;
  const resourceId  = String(webhookMeta?.resource_id ?? '');
  if (resourceId && fetchedId && fetchedId !== resourceId) {
    console.warn(`Uber order id mismatch: fetched="${fetchedId}" webhook resource_id="${resourceId}"`);
  }

  return {
    id:                randomUUID(),
    provider:          'uber',
    external_order_id: fetchedId || resourceId,
    status:            normaliseUberStatus(String(orderPayload.current_state ?? '')),
    customer:          [eater.first_name, eater.last_name].filter(Boolean).join(' ') || 'Unknown',
    line_items,
    total_cents:       Number(total.amount ?? 0),
    currency:          String(total.currency_code ?? 'USD'),
    created_at:        String(orderPayload.placed_at ?? new Date().toISOString()),
    raw_payload:       { webhook: rawWebhook, order: orderPayload },
  };
}

// ---------------------------------------------------------------------------
// DoorDash webhook order → InternalOrder  (§7)
//
//   order.id                                  → external_order_id
//   event.status (NEW)                        → status (normalised)
//   order.consumer.first_name + last_name     → customer
//   order.categories[].items[]                → line_items
//     item.price + Σ extras options           → unit_price_cents  (§7)
//   order.subtotal + order.tax                → total_cents  (§9 item 3)
//   currency not in payload                   → 'USD' (configured default, §9 item C)
//   no created_at in payload                  → webhook receipt time  (§7, §9 item C)
// ---------------------------------------------------------------------------
export function fromDoorDashOrder(
  payload: Record<string, unknown>,
  receivedAt?: string
): InternalOrder {
  const order      = (payload.order    as Record<string, unknown>) ?? {};
  const event      = (payload.event    as Record<string, unknown>) ?? {};
  const consumer   = (order.consumer   as Record<string, unknown>) ?? {};
  const categories = (order.categories as unknown[])               ?? [];

  const line_items: LineItem[] = categories.flatMap((cat) => {
    const category = cat as Record<string, unknown>;
    const items    = (category.items as unknown[]) ?? [];
    return items.map((i) => {
      const item = i as Record<string, unknown>;
      return {
        name:             String(item.name ?? ''),
        quantity:         Number(item.quantity ?? 1),
        unit_price_cents: ddItemUnitPrice(item),
      };
    });
  });

  const customerName =
    [consumer.first_name, consumer.last_name].filter(Boolean).join(' ') || 'Unknown';

  // item 3: total_cents = subtotal + tax (tips excluded; tax may be remitted by DoorDash)
  const totalCents = Number(order.subtotal ?? 0) + Number(order.tax ?? 0);

  return {
    id:                randomUUID(),
    provider:          'doordash',
    external_order_id: String(order.id ?? ''),
    status:            normaliseDoorDashStatus(String(event.status ?? '')),
    customer:          customerName,
    line_items,
    total_cents:       totalCents,
    currency:          'USD', // §9 item C: not in payload; configured default
    created_at:        receivedAt ?? new Date().toISOString(), // §7: use receipt time
    raw_payload:       payload,
  };
}
