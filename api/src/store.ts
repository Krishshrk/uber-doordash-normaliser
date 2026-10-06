import { getDb, persist } from './db';
import { InternalOrder } from './types';

function row(o: InternalOrder) {
  return [
    o.id,
    o.provider,
    o.external_order_id,
    o.status,
    o.customer,
    JSON.stringify(o.line_items),
    o.total_cents,
    o.currency,
    o.created_at,
    JSON.stringify(o.raw_payload),
  ];
}

function toOrder(r: Record<string, unknown>): InternalOrder {
  return {
    id:                r.id as string,
    provider:          r.provider as InternalOrder['provider'],
    external_order_id: r.external_order_id as string,
    status:            r.status as InternalOrder['status'],
    customer:          r.customer as string,
    line_items:        JSON.parse(r.line_items as string),
    total_cents:       r.total_cents as number,
    currency:          r.currency as string,
    created_at:        r.created_at as string,
    raw_payload:       JSON.parse(r.raw_payload as string),
  };
}

export async function upsertOrder(order: InternalOrder): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT INTO orders (id,provider,external_order_id,status,customer,line_items,total_cents,currency,created_at,raw_payload)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,external_order_id) DO UPDATE SET
       status=excluded.status,
       customer=excluded.customer,
       line_items=excluded.line_items,
       total_cents=excluded.total_cents,
       currency=excluded.currency,
       raw_payload=excluded.raw_payload`,
    row(order)
  );
  persist();
}

// Uber event_id dedup — docs: retries can re-deliver the same event_id.
// Returns true if this event_id is new (should be processed), false if already seen.
export async function markUberEvent(eventId: string): Promise<boolean> {
  const db = await getDb();
  try {
    db.run('INSERT INTO uber_events (event_id) VALUES (?)', [eventId]);
    persist();
    return true;
  } catch {
    // UNIQUE constraint violation → already processed
    return false;
  }
}

export async function listOrders(): Promise<InternalOrder[]> {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM orders ORDER BY created_at DESC');
  const rows: InternalOrder[] = [];
  while (stmt.step()) rows.push(toOrder(stmt.getAsObject() as Record<string, unknown>));
  stmt.free();
  return rows;
}

export async function getOrder(id: string): Promise<InternalOrder | null> {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM orders WHERE id=?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const o = toOrder(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return o;
}

export async function updateStatus(id: string, status: InternalOrder['status']): Promise<boolean> {
  const db = await getDb();
  db.run('UPDATE orders SET status=? WHERE id=?', [status, id]);
  persist();
  return db.getRowsModified() > 0;
}
