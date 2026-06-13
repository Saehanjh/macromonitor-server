import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: 'http_error',
      message: err.message,
      details: err.details,
    });
    return;
  }

  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 502;
    res.status(status).json({
      error: 'upstream_error',
      message: err.message,
      upstreamStatus: err.response?.status,
      // upstream bodies can echo request details (URLs, keys) — dev only
      ...(process.env.NODE_ENV !== 'production' ? { upstreamData: err.response?.data } : {}),
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[errorHandler]', err);
  res.status(500).json({ error: 'internal_error', message });
}
