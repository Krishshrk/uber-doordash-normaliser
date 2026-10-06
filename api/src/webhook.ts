import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { verifyUber, verifyDoorDash } from './auth';
import { fromUberOrder, fromDoorDashOrder } from './normalise';
import { upsertOrder, markUberEvent } from './store';

const router = Router();

// ---------------------------------------------------------------------------
// Provider detection — payload shape only, no injected fields, no query params.
//
//   Uber:     event_type starts with "orders."
//             AND meta.resource_id present
//             AND resource_href present
//   DoorDash: event.type === "OrderCreate"
//             AND order object present
//
// Both conditions must hold. A payload missing any required field gets 400.
// ---------------------------------------------------------------------------
export function detectProvider(body: Record<string, unknown>): 'uber' | 'doordash' | null {
  const eventType = String(body.event_type ?? '');
  const meta      = body.meta as Record<string, unknown> | undefined;

  if (
    eventType.startsWith('orders.') &&
    meta?.resource_id &&
    body.resource_href
  ) {
    return 'uber';
  }

  const event = body.event as Record<string, unknown> | undefined;
  if (event?.type === 'OrderCreate' && body.order) {
    return 'doordash';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auth middleware selector — runs the correct verifier as real Express
// middleware so next() / res.status(401) work without a promise wrapper.
// Must run after detectProvider so we know which scheme to apply.
// ---------------------------------------------------------------------------
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const provider = detectProvider(req.body as Record<string, unknown>);
  if (provider === 'uber')     return verifyUber(req, res, next);
  if (provider === 'doordash') return verifyDoorDash(req, res, next);
  next(); // unknown provider — handled in the route handler
}

// ---------------------------------------------------------------------------
// Uber flow:
//   1. 200 empty body sent immediately by the route handler before this runs
//   2. Dedupe on event_id — Uber retries up to 7 times with same event_id
//   3. Only orders.notification / orders.scheduled.notification create rows;
//      all other Uber event types are ack'd 200 and silently ignored (doc §5)
//   4. Fetch full order via resource_href (canonical URL from the webhook)
//      Falls back to building the URL from UBER_API_BASE + resource_id
//   5. Log if fetched order.id ≠ webhook meta.resource_id (doc §9 item 7)
// ---------------------------------------------------------------------------
async function handleUber(body: Record<string, unknown>, rawWebhook: unknown): Promise<void> {
  const eventType = String(body.event_type ?? '');
  const eventId   = String(body.event_id   ?? '');

  if (eventType !== 'orders.notification' && eventType !== 'orders.scheduled.notification') {
    console.log(`Uber event "${eventType}" — ack'd, not ingested`);
    return;
  }

  if (eventId) {
    const isNew = await markUberEvent(eventId);
    if (!isNew) {
      console.log(`Uber event_id ${eventId} already processed — skipping`);
      return;
    }
  }

  const meta        = (body.meta as Record<string, unknown>) ?? {};
  const resourceId  = String(meta.resource_id ?? '');
  // resource_href is the canonical GET URL, build fallback only if absent
  const resourceUrl = String(
    body.resource_href ??
    `${process.env.UBER_API_BASE ?? 'https://api.uber.com'}/v2/eats/order/${resourceId}`
  );

  const token = process.env.UBER_ACCESS_TOKEN ?? '';
  let orderPayload: Record<string, unknown>;

  if (token) {
    const { data } = await axios.get<Record<string, unknown>>(resourceUrl, {
      headers: {
        Authorization:     `Bearer ${token}`,
        'Accept-Encoding': 'gzip', // response can be very large
      },
    });
    orderPayload = data;
  } else {
    // Dev/fixture mode: no token → synthesise minimal Get Order shaped object.
    // current_state is not in the webhook body; default CREATED → 'new'.
    orderPayload = {
      id:            resourceId,
      current_state: 'CREATED',
      placed_at:     new Date().toISOString(),
      eater:         {},
      cart:          { items: [] },
      payment:       { charges: { total: { amount: 0, currency_code: 'USD' } } },
    };
  }

  await upsertOrder(fromUberOrder(orderPayload, rawWebhook));
}

// ---------------------------------------------------------------------------
// DoorDash flow :
//   Webhook IS the full order — no secondary fetch needed.
//   Respond 202 (async confirm later); 200 = synchronously accepted (doc §9 item B).
//   Dedup via UNIQUE(provider, external_order_id) in the upsert.
// ---------------------------------------------------------------------------
async function handleDoorDash(
  body: Record<string, unknown>,
  receivedAt: string
): Promise<void> {
  await upsertOrder(fromDoorDashOrder(body, receivedAt));
}

// ---------------------------------------------------------------------------
// POST /api/webhook — single ingest endpoint for both providers.
//
// Middleware order matters:
//   1. authMiddleware — verifies signature/token; sends 401 and stops if invalid
//   2. route handler  — detects provider, responds, processes
// ---------------------------------------------------------------------------
router.post('/webhook', authMiddleware, async (req: Request, res: Response) => {
  const body       = req.body as Record<string, unknown>;
  const provider   = detectProvider(body);
  const receivedAt = new Date().toISOString();

  if (!provider) {
    return res.status(400).json({ error: 'Unknown provider' });
  }

  try {
    if (provider === 'uber') {
      // respond 200 empty body immediately, then process asynchronously
      res.status(200).send();
      await handleUber(body, body);
    } else {
      // 202 = async confirm later
      await handleDoorDash(body, receivedAt);
      res.status(202).send();
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
