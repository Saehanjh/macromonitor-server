import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';

const router = Router();
type Pt = { t: number; v: number };

// ── upstream helpers ───────────────────────────────────────────────────
interface YahooResp {
  chart: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
}
async function fetchYahooPoints(symbol: string, range: string, interval: string): Promise<Pt[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await proxyFetch<YahooResp>({ key: `yahoo:${symbol}:${interval}:${range}`, url, ttlSec: config.cache.price });
  const res = r.data.chart?.result?.[0];
  const ts = res?.timestamp ?? [];
  const cl = res?.indicators?.quote?.[0]?.close ?? [];
  const out: Pt[] = [];
  ts.forEach((t, i) => {
    const c = cl[i];
    if (c != null && Number.isFinite(c)) out.push({ t, v: Number(c.toFixed(4)) });
  });
  return out;
}

interface FredResp {
  observations?: Array<{ date: string; value: string }>;
}
async function fetchFredPoints(id: string, limit: number): Promise<Pt[]> {
  const params = new URLSearchParams({
    series_id: id,
    api_key: config.fredApiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  });
  const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
  const r = await proxyFetch<FredResp>({ key: `fred:${id}:g:${limit}`, url, ttlSec: config.cache.macro });
  return (r.data.observations ?? [])
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ t: Math.floor(Date.parse(o.date) / 1000), v: Number(o.value) }))
    .filter((p) => Number.isFinite(p.v))
    .reverse();
}

const RANGE: Record<string, { yr: string; yi: string; fl: number; n: number }> = {
  '3M': { yr: '3mo', yi: '1d', fl: 75, n: 66 },
  '6M': { yr: '6mo', yi: '1d', fl: 135, n: 128 },
  '1Y': { yr: '1y', yi: '1d', fl: 270, n: 260 },
  '3Y': { yr: '5y', yi: '1wk', fl: 820, n: 156 },
  '5Y': { yr: '5y', yi: '1wk', fl: 1320, n: 260 },
};
const rangeKey = (q: unknown): string => (typeof q === 'string' && RANGE[q] ? q : '1Y');

function synthDaily(base: number, n: number, vol: number, drift = 0): Pt[] {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: Pt[] = [];
  let v = base;
  for (let i = n - 1; i >= 0; i--) {
    v = Math.max(base * 0.2, v + (Math.random() - 0.5) * vol + drift);
    out.push({ t: now - i * day, v: Number(v.toFixed(4)) });
  }
  return out;
}

// ── /dollar (DXY vs Broad Dollar + SPY overlay) ────────────────────────
router.get('/dollar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rk = rangeKey(req.query.range);
    const r = RANGE[rk];
    let source: 'live' | 'dummy' = 'dummy';

    let dxy = synthDaily(104, r.n, 0.3);
    let broad = synthDaily(121, r.n, 0.25);
    let spy = synthDaily(560, r.n, 4);

    try { const d = await fetchYahooPoints('DX-Y.NYB', r.yr, r.yi); if (d.length) { dxy = d; source = 'live'; } } catch { /* dummy */ }
    try { const s = await fetchYahooPoints('SPY', r.yr, r.yi); if (s.length) spy = s; } catch { /* dummy */ }
    if (hasFredKey()) {
      try { const b = await fetchFredPoints('DTWEXBGS', r.fl); if (b.length) { broad = b; source = 'live'; } } catch { /* dummy */ }
    }

    res.json({ dxy: { points: dxy }, broad: { points: broad }, spy: { points: spy }, range: rk, source });
  } catch (err) {
    next(err);
  }
});

// ── generic pair handler (factory / demand) ────────────────────────────
async function pairHandler(
  req: Request,
  res: Response,
  next: NextFunction,
  aSym: string,
  aLabel: string,
  aBase: number,
  aVol: number,
  bSym: string,
  bLabel: string,
  bBase: number,
  bVol: number,
) {
  try {
    const rk = rangeKey(req.query.range);
    const r = RANGE[rk];
    let source: 'live' | 'dummy' = 'dummy';

    let aPts = synthDaily(aBase, r.n, aVol);
    let bPts = synthDaily(bBase, r.n, bVol);

    try { const a = await fetchYahooPoints(aSym, r.yr, r.yi); if (a.length) { aPts = a; source = 'live'; } } catch { /* dummy */ }
    try { const b = await fetchYahooPoints(bSym, r.yr, r.yi); if (b.length) { bPts = b; source = 'live'; } } catch { /* dummy */ }

    res.json({
      a: { symbol: aSym, label: aLabel, points: aPts },
      b: { symbol: bSym, label: bLabel, points: bPts },
      range: rk,
      source,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/factory', (req, res, next) =>
  pairHandler(req, res, next, 'AUDUSD=X', 'AUD/USD', 0.66, 0.004, '^KS11', 'KOSPI', 2600, 18),
);
router.get('/demand', (req, res, next) =>
  pairHandler(req, res, next, 'EURUSD=X', 'EUR/USD', 1.08, 0.005, 'FEZ', 'FEZ', 50, 0.5),
);

export default router;
