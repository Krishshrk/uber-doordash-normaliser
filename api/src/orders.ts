import { Router, Request, Response } from 'express';
import { listOrders, getOrder, updateStatus } from './store';
import type { OrderStatus } from './types';

const router = Router();

// §8: forward-only progression; canceled and rejected are terminal exits
const STATUS_ORDER: OrderStatus[] = ['new', 'accepted', 'ready', 'completed'];
const TERMINAL: OrderStatus[]     = ['canceled', 'rejected'];

router.get('/orders', async (_req: Request, res: Response) => {
  try {
    res.json(await listOrders());
  } catch {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id', async (req: Request, res: Response) => {
  const order = await getOrder(String(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

router.patch('/orders/:id/status', async (req: Request, res: Response) => {
  const body   = (req.body ?? {}) as { status?: OrderStatus };
  const status = body.status;
  const allValid: OrderStatus[] = [...STATUS_ORDER, ...TERMINAL];

  if (!status || !allValid.includes(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}` });
  }

  const order = await getOrder(String(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });

  // Block moves from a terminal state
  if (TERMINAL.includes(order.status)) {
    return res.status(400).json({ error: `Order is already ${order.status}` });
  }

  // Non-terminal moves must go forward.
  // currentIdx === -1 means a stale status not in STATUS_ORDER (e.g. 'pending')
  // — allow any forward move from it.
  if (!TERMINAL.includes(status)) {
    const currentIdx = STATUS_ORDER.indexOf(order.status);
    const newIdx     = STATUS_ORDER.indexOf(status);
    if (currentIdx !== -1 && newIdx <= currentIdx) {
      return res.status(400).json({ error: 'Status can only move forward' });
    }
  }

  await updateStatus(String(req.params.id), status);
  res.json({ ok: true });
});

export default router;
