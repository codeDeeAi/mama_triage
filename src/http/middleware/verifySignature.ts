/**
 * WhatsApp webhook signature verification.
 *
 * Without this the webhook is an open endpoint: anyone who learns the URL can drive the
 * triage system, fabricate messages from any phone number, and pollute the session store.
 *
 * Meta signs the raw request body with the app secret and sends the digest in
 * `X-Hub-Signature-256`. Verification must therefore run against the *raw bytes*, before
 * any JSON parsing — a re-serialised body will not reproduce the same digest.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface VerifiedRequest extends Request {
  /** The parsed webhook body, set only after the signature is verified. */
  verifiedBody?: unknown;
}

/**
 * Compare two signature strings in constant time.
 *
 * `timingSafeEqual` throws on unequal buffer lengths, so lengths are checked first — but
 * the length check itself is not a timing leak of any consequence, since the digest
 * length is fixed and public.
 */
export function signaturesMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Compute the expected `sha256=…` header value for a raw body. */
export function computeSignature(rawBody: Buffer, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/**
 * Express middleware verifying `X-Hub-Signature-256`.
 *
 * Must be mounted after a raw body parser (`express.raw`) and before any JSON parsing.
 * On success the parsed body is attached as `req.verifiedBody`.
 *
 * @param onReject Optional hook for audit logging of rejected requests.
 */
export function verifySignature(
  appSecret: string,
  onReject?: (reason: string) => void,
) {
  return function verifySignatureMiddleware(
    req: VerifiedRequest,
    res: Response,
    next: NextFunction,
  ): void {
    const reject = (status: number, reason: string): void => {
      onReject?.(reason);
      res.status(status).json({ error: reason });
    };

    const received = req.get('X-Hub-Signature-256');
    if (!received) {
      reject(401, 'missing signature');
      return;
    }

    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      // The route is misconfigured — express.json ran first and consumed the stream, so
      // the original bytes are gone and no signature can be verified. Failing closed is
      // the only safe response.
      reject(500, 'raw body unavailable for signature verification');
      return;
    }

    if (!signaturesMatch(received, computeSignature(raw, appSecret))) {
      reject(401, 'invalid signature');
      return;
    }

    try {
      req.verifiedBody = JSON.parse(raw.toString('utf8'));
    } catch {
      reject(400, 'malformed JSON body');
      return;
    }

    next();
  };
}
