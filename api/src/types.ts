export type Provider = 'uber' | 'doordash';

// internal status set
// new → accepted → ready → completed  (forward only)
// canceled and rejected are terminal exits at any point
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

export interface InternalOrder {
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
