import express, { Request } from 'express';
import 'dotenv/config';
import webhookRouter from './webhook';
import ordersRouter  from './orders';
import { getDb, persist } from './db';

const app  = express();
const PORT = process.env.PORT ?? 3001;

// Two-pass body handling — works reliably on Express 4 and 5:
//   1. express.raw buffers every request into req.body (a Buffer)
//   2. We stash it as req.rawBody for Uber HMAC, then JSON-parse into req.body
// This avoids the express.json verify-callback behaviour differences in Express 5.
type RawBodyRequest = Request & { rawBody?: Buffer };

app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.use((req: RawBodyRequest, res, next) => {
  const buf = req.body as Buffer | undefined;
  req.rawBody = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);

  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('application/json') && req.rawBody.length > 0) {
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
  } else {
    req.body = {};
  }
  next();
});

app.use('/api', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Uber-Signature,X-Environment');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', webhookRouter);
app.use('/api', ordersRouter);

async function seed() {
  const { listOrders, upsertOrder } = await import('./store');

  // Migrate any rows seeded by old code that used 'pending' instead of 'new'
  const db = await getDb();
  db.run(`UPDATE orders SET status='new' WHERE status='pending'`);
  db.run(`UPDATE orders SET status='canceled' WHERE status='cancelled'`);
  persist();

  const existing = await listOrders();
  if (existing.length > 0) return;

  const { fromUberOrder, fromDoorDashOrder } = await import('./normalise');
  const { randomUUID } = await import('crypto');

  // Seed data uses the Get Order shape for Uber (not the thin webhook shape)
  const uberOrders = [
    {
      id: 'uber-order-001',
      current_state: 'CREATED',
      placed_at: new Date(Date.now() - 5 * 60000).toISOString(),
      eater: { first_name: 'Alice', last_name: 'M' },
      cart: {
        items: [
          { title: 'Margherita Pizza', quantity: 1, price: { unit_price: { amount: 1299, currency_code: 'USD' } } },
          { title: 'Garlic Bread',     quantity: 2, price: { unit_price: { amount:  399, currency_code: 'USD' } } },
        ],
      },
      payment: { charges: { total: { amount: 2097, currency_code: 'USD' } } },
    },
    {
      id: 'uber-order-002',
      current_state: 'ACCEPTED',
      placed_at: new Date(Date.now() - 15 * 60000).toISOString(),
      eater: { first_name: 'Bob', last_name: 'K' },
      cart: {
        items: [
          { title: 'Chicken Burger', quantity: 2, price: { unit_price: { amount: 899, currency_code: 'USD' } } },
          { title: 'Fries',          quantity: 2, price: { unit_price: { amount: 349, currency_code: 'USD' } } },
        ],
      },
      payment: { charges: { total: { amount: 2496, currency_code: 'USD' } } },
    },
  ];

  const ddOrders = [
    {
      event: { type: 'OrderCreate', status: 'NEW' },
      order: {
        id: 'dd-order-001',
        subtotal: 1850,
        estimated_pickup_time: new Date(Date.now() - 2 * 60000).toISOString(),
        consumer: { first_name: 'Carol', last_name: 'T', phone: '+15550001111' },
        categories: [{ items: [
          { name: 'Burrito Bowl', quantity: 1, price: 1200 },
          { name: 'Chips & Guac', quantity: 1, price:  650 },
        ]}],
      },
    },
    {
      event: { type: 'OrderCreate', status: 'NEW' },
      order: {
        id: 'dd-order-002',
        subtotal: 2200,
        estimated_pickup_time: new Date(Date.now() - 30 * 60000).toISOString(),
        consumer: { first_name: 'Dan', last_name: 'R', phone: '+15550002222' },
        categories: [{ items: [
          { name: 'Pad Thai',    quantity: 1, price: 1400 },
          { name: 'Spring Roll', quantity: 2, price:  400 },
        ]}],
      },
    },
    {
      event: { type: 'OrderCreate', status: 'NEW' },
      order: {
        id: 'dd-order-003',
        subtotal: 950,
        estimated_pickup_time: new Date(Date.now() - 45 * 60000).toISOString(),
        consumer: { first_name: 'Eva', last_name: 'S', phone: '+15550003333' },
        categories: [{ items: [
          { name: 'Caesar Salad', quantity: 1, price: 950 },
        ]}],
      },
    },
  ];

  for (const o of uberOrders) {
    const rawWebhook = { event_type: 'orders.notification', event_id: randomUUID(), meta: { resource_id: o.id } };
    await upsertOrder(fromUberOrder(o, rawWebhook));
  }
  for (const o of ddOrders) {
    await upsertOrder(fromDoorDashOrder(o, new Date(Date.now() - 60000).toISOString()));
  }

  console.log('Seeded 5 demo orders');
}

getDb()
  .then(() => seed())
  .then(() => {
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Startup error:', err);
    process.exit(1);
  });
