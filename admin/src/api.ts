import type { Order, OrderStatus } from './types';

const BASE = 'http://localhost:3001/api';

export async function fetchOrders(): Promise<Order[]> {
  const res = await fetch(`${BASE}/orders`);
  if (!res.ok) throw new Error(`Failed to fetch orders: ${res.status}`);
  return res.json();
}

export async function fetchOrder(id: string): Promise<Order> {
  const res = await fetch(`${BASE}/orders/${id}`);
  if (!res.ok) throw new Error(`Order not found: ${res.status}`);
  return res.json();
}

export async function patchStatus(id: string, status: OrderStatus): Promise<void> {
  const res = await fetch(`${BASE}/orders/${id}/status`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update status: ${res.status}`);
}
