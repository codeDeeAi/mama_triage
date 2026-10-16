/**
 * Forward a rejected async route handler to Express's error middleware.
 *
 * Express 4 ignores the promise a handler returns. Without this wrapper, a database or
 * LLM failure inside an `async` route is an unhandled rejection and the request hangs
 * until the client gives up, instead of receiving the app's 500 response.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}
