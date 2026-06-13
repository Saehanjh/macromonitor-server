import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { HttpError } from '../middleware/errorHandler';

const router = Router();

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
  count?: number;
  realtime_start?: string;
  realtime_end?: string;
}

router.get('/:seriesId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!hasFredKey()) {
      throw new HttpError(500, 'FRED_API_KEY is not configured on the server');
    }

    const { seriesId } = req.params;
    const { start, end, limit, sort } = req.query;

    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: config.fredApiKey,
      file_type: 'json',
    });
    if (typeof start === 'string') params.set('observation_start', start);
    if (typeof end === 'string') params.set('observation_end', end);
    if (typeof limit === 'string') params.set('limit', limit);
    if (typeof sort === 'string') params.set('sort_order', sort);

    const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
    // cache key from request inputs only — never include the api_key string
    const cacheKey = `fred:${seriesId}:${start ?? ''}:${end ?? ''}:${limit ?? ''}:${sort ?? ''}`;

    const result = await proxyFetch<FredResponse>({
      key: cacheKey,
      url,
      ttlSec: config.cache.macro,
    });

    res.setHeader('X-Cache', result.source);
    res.json({
      seriesId,
      observations: result.data.observations ?? [],
      count: result.data.count ?? result.data.observations?.length ?? 0,
      source: result.source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
