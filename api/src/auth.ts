import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

type RawRequest = Request & { rawBody?: Buffer };

// ---------------------------------------------------------------------------
// Uber: HMAC-SHA256 of raw request body bytes, keyed with client secret.
// Header: X-Uber-Signature (lowercase hex).
// ---------------------------------------------------------------------------
export function verifyUber(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.UBER_CLIENT_SECRET ?? '';
  if (!secret) return next(); // dev: skip when not configured

  const sig = req.headers['x-uber-signature'] as string | undefined;
  if (!sig) return res.status(401).json({ error: 'Missing X-Uber-Signature' });

  const rawBody  = (req as RawRequest).rawBody ?? Buffer.alloc(0);
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid Uber signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid Uber signature' });
  }
  next();
}

// ---------------------------------------------------------------------------
// DoorDash: compare Authorization header to configured token.
// compared to DOORDASH_WEBHOOK_AUTH.
// ---------------------------------------------------------------------------
export function verifyDoorDash(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.DOORDASH_WEBHOOK_AUTH ?? '';
  if (!secret) return next(); // dev: skip when not configured

  const auth  = String(req.headers['authorization'] ?? '');
  // Accept both raw token and "Bearer <token>" forms
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Invalid DoorDash authorization' });
  }
  next();
}
