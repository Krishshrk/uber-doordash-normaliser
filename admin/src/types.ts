export type Provider = 'uber' | 'doordash';

// §8: new → accepted → ready → completed; canceled/rejected are terminal exits
export type OrderStatus =
  | 'new'
  | 'accepted'
  | 'ready'
  | 'completed'
  | 'canceled'
  | 'rejected';

export interface LineItem {
  name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface Order {
  id: string;
  provider: Provider;
  external_order_id: string;
  status: OrderStatus;
  customer: string;
  line_items: LineItem[];
  total_cents: number;
  currency: string;
  created_at: string;
  raw_payload: unknown;
}

export const STATUS_ORDER: OrderStatus[] = ['new', 'accepted', 'ready', 'completed'];
export const TERMINAL_STATUSES: OrderStatus[] = ['canceled', 'rejected'];

export function formatMoney(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function nextStatuses(current: OrderStatus): OrderStatus[] {
  if (TERMINAL_STATUSES.includes(current)) return [];
  if (current === 'completed') return [];
  const idx = STATUS_ORDER.indexOf(current);
  // idx === -1 means a stale/unknown status (e.g. 'pending' from old data)
  // treat it as position -1 so the full forward progression is offered
  const forward = STATUS_ORDER.slice(idx + 1);
  return [...forward, 'canceled', 'rejected'];
}
