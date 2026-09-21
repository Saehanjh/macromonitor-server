import { requireRealMacroData } from '../middleware/realMacroData';
import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { fetchYahooChart } from '../services/yahooProvider';

const router = Router();
router.use(requireRealMacroData);
type Pt = { t: number; v: number };

// ── upstream helpers ───────────────────────────────────────────────────
interface YahooResp {
  chart: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
}
async function fetchYahooCloses(symbol: string, range = '2mo', interval = '1d'): Promise<number[]> {
  const r = await fetchYahooChart<YahooResp>(symbol, range, interval);
  const closes = r.data.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c): c is number => c != null && Number.isFinite(c));
}

interface FredResp {
  observations?: Array<{ date: string; value: string }>;
}
/**
 * The documented FRED API requires a key.  FRED's own graph CSV export is
 * public, however, and is a useful authoritative fallback when a deployment
 * is missing a key or the keyed endpoint is temporarily unavailable.
 */
export function parseFredGraphCsv(csv: string, limit: number): Pt[] {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2) return [];
  return rows.slice(1)
    .map((row) => {
      const comma = row.indexOf(',');
      if (comma < 0) return null;
      const date = row.slice(0, comma).trim();
      const value = Number(row.slice(comma + 1).trim());
      const t = Math.floor(Date.parse(date) / 1000);
      return Number.isFinite(t) && Number.isFinite(value) ? { t, v: value } : null;
    })
    .filter((point): point is Pt => point !== null)
    .slice(-limit);
}

async function fetchFredGraphCsvPoints(seriesId: string, limit: number): Promise<Pt[]> {
  const observationStart = new Date();
  observationStart.setUTCFullYear(observationStart.getUTCFullYear() - 6);
  const start = observationStart.toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${new URLSearchParams({ id: seriesId, cos: 'Close', observation_start: start }).toString()}`;
  const r = await proxyFetch<string>({
    key: `fredcsv:${seriesId}:${limit}`,
    url,
    ttlSec: config.cache.macro,
    axiosConfig: { responseType: 'text', headers: { Accept: 'text/csv' } },
  });
  return parseFredGraphCsv(r.data, limit);
}

async function fetchFredPoints(seriesId: string, limit: number): Promise<Pt[]> {
  if (hasFredKey()) {
    try {
      const params = new URLSearchParams({
        series_id: seriesId,
        api_key: config.fredApiKey,
        file_type: 'json',
        sort_order: 'desc',
        limit: String(limit),
      });
      const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
      const r = await proxyFetch<FredResp>({ key: `fred:${seriesId}:e:${limit}`, url, ttlSec: config.cache.macro });
      const points = (r.data.observations ?? [])
        .filter((o) => o.value !== '.' && o.value !== '')
        .map((o) => ({ t: Math.floor(Date.parse(o.date) / 1000), v: Number(o.value) }))
        .filter((p) => Number.isFinite(p.v))
        .reverse();
      if (points.length) return points;
    } catch { /* use FRED's public graph export below */ }
  }
  return fetchFredGraphCsvPoints(seriesId, limit);
}





// ── /commodities (12 Yahoo futures) ────────────────────────────────────
const COMMODITIES: Array<{ symbol: string; name: string; base: number; vol: number }> = [
  { symbol: 'CL=F', name: 'WTI 원유', base: 78, vol: 1.4 },
  { symbol: 'BZ=F', name: '브렌트유', base: 82, vol: 1.4 },
  { symbol: 'NG=F', name: '천연가스', base: 2.8, vol: 0.12 },
  { symbol: 'GC=F', name: '금', base: 2350, vol: 22 },
  { symbol: 'SI=F', name: '은', base: 29, vol: 0.5 },
  { symbol: 'PL=F', name: '백금', base: 980, vol: 14 },
  { symbol: 'HG=F', name: '구리', base: 4.3, vol: 0.06 },
  { symbol: 'ALI=F', name: '알루미늄', base: 2450, vol: 30 },
  { symbol: 'ZW=F', name: '소맥', base: 580, vol: 9 },
  { symbol: 'ZC=F', name: '옥수수', base: 430, vol: 6 },
  { symbol: 'ZS=F', name: '대두', base: 1180, vol: 14 },
  { symbol: 'KC=F', name: '커피', base: 230, vol: 5 },
];

router.get('/commodities', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const commodities = await Promise.all(
      COMMODITIES.map(async (c) => {
        try {
          const closes = await fetchYahooCloses(c.symbol, '2mo');
          if (closes.length >= 21) {
            anyLive = true;
            return { symbol: c.symbol, name: c.name, closes: closes.slice(-25) };
          }
        } catch { /* fall through */ }
        return { symbol: c.symbol, name: c.name, closes: ([] as number[]) };
      }),
    );
    res.json({ commodities, source: anyLive ? 'live' : 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── /inflation (6 FRED series, YoY computed on frontend) ────────────────
const INFLATION: Array<{ key: string; id: string; base: number; mom: number }> = [
  { key: 'CPI', id: 'CPIAUCSL', base: 313, mom: 0.0025 },
  { key: 'CoreCPI', id: 'CPILFESL', base: 319, mom: 0.0027 },
  { key: 'PPI', id: 'PPIFIS', base: 145, mom: 0.002 },
  { key: 'PCE', id: 'PCEPI', base: 124, mom: 0.0021 },
  { key: 'CorePCE', id: 'PCEPILFE', base: 122, mom: 0.0023 },
  { key: 'Wage', id: 'CES0500000003', base: 35, mom: 0.0035 },
];

router.get('/inflation', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const series: Record<string, { points: Pt[] }> = {};
    let anyLive = false;

    if (hasFredKey()) {
      const results = await Promise.all(
        INFLATION.map(async (s) => {
          try {
            return [s.key, await fetchFredPoints(s.id, 16)] as const;
          } catch {
            return [s.key, [] as Pt[]] as const;
          }
        }),
      );
      for (const [key, pts] of results) {
        const def = INFLATION.find((i) => i.key === key)!;
        if (pts.length >= 13) {
          series[key] = { points: pts };
          anyLive = true;
        } else {
          series[key] = { points: ([] as Pt[]) };
        }
      }
    } else {
      for (const s of INFLATION) series[s.key] = { points: ([] as Pt[]) };
    }

    res.json({ series, source: anyLive ? 'live' : 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── /expectations (BEI 10Y, 5Y5Y Forward, Michigan) ────────────────────
router.get('/expectations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let bei = ([] as Pt[]);
    let fwd = ([] as Pt[]);
    let mich: Pt[] = [];

    if (hasFredKey()) {
      try { const b = await fetchFredPoints('T10YIE', 70); if (b.length) { bei = b; source = 'live'; } } catch { /* input remains unavailable */ }
      try { const f = await fetchFredPoints('T5YIFR', 70); if (f.length) { fwd = f; source = 'live'; } } catch { /* input remains unavailable */ }
      try { const m = await fetchFredPoints('MICH', 14); if (m.length) { mich = m; source = 'live'; } } catch { /* input remains unavailable */ }
    }

    res.json({ bei: { points: bei }, fwd: { points: fwd }, mich: { points: mich }, source });
  } catch (err) {
    next(err);
  }
});

// ── Phase 9: Corporate Pulse / Labor Pipeline / Consumer Health ─────────

async function latestVal(id: string): Promise<number | null> {
  try {
    const p = await fetchFredPoints(id, 3);
    return p.length ? p[p.length - 1].v : null;
  } catch {
    return null;
  }
}

// ── /corporate ─────────────────────────────────────────────────────────
// GDPNow is the Atlanta Fed nowcast (FRED-published series GDPNOW).
// TODO(Atlanta): optionally parse https://www.atlantafed.org GDPNow JSON directly.
const MFG_DEFS = [
  { id: 'GACDISA066MSFRBNY', name: 'NY Empire', base: -8 },
  { id: 'GACDFSA066MSFRBPHI', name: 'Philadelphia', base: -5 },
  { id: 'BACTSAMFRBDAL', name: 'Dallas', base: -12 },
  { id: 'RCMFSA', name: 'Richmond', base: -3 },
];
const SVC_DEFS = [
  { id: 'TSSOSGBA066MSFRBDAL', name: 'Dallas Svc', base: 5 },
  { id: 'BACTSAMFRBNY', name: 'NY Svc', base: 8 },
  { id: 'GACDFNA066MNFRBPHI', name: 'Philly Svc', base: 12 },
];

router.get('/corporate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;

    let gdpNow = Number.NaN;
    if (hasFredKey()) {
      const g = await latestVal('GDPNOW');
      if (g != null) { gdpNow = g; anyLive = true; }
    }

    const buildComposite = async (defs: typeof MFG_DEFS) => {
      // FRED permits the individual series but can reject a burst of seven
      // requests from Render's shared address.  Fetch these small observations
      // in sequence; proxy caching makes later screen visits immediate.
      const attempted: Array<{ name: string; value: number; live: true } | null> = [];
      for (const d of defs) {
        let v: number | null = null;
        try { v = await latestVal(d.id); } catch { /* unavailable component is omitted */ }
        const live = v != null;
        if (live) anyLive = true;
        attempted.push(live ? { name: d.name, value: Number(v!.toFixed(1)), live: true } : null);
      }
      // A regional survey can be delayed or discontinued independently. Show
      // the real observations that are available rather than rejecting the
      // entire Corporate Pulse card or filling a missing survey with a value.
      const components = attempted.filter((component): component is { name: string; value: number; live: true } => component !== null);
      if (!components.length) return null;
      const avg = components.reduce((a, c) => a + c.value, 0) / components.length;
      return { value: Number(avg.toFixed(1)), components, coverage: { available: components.length, total: defs.length } };
    };

    const mfg = await buildComposite(MFG_DEFS);
    const svc = await buildComposite(SVC_DEFS);

    if (!mfg || !svc || !Number.isFinite(gdpNow) || !anyLive) {
      res.status(503).json({
        error: 'macro_data_unavailable',
        message: '기업활동 실측치를 충분히 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.',
        endpoint: '/api/economy/corporate',
      });
      return;
    }
    res.json({ gdpNow: Number(gdpNow.toFixed(1)), mfg, svc, source: 'live' });
  } catch (err) {
    next(err);
  }
});

// ── /labor (5-stage domino) ────────────────────────────────────────────
const LABOR_DEFS = [
  { key: 'jolts', id: 'JTSJOL', name: 'JOLTS 구인', base: 8050, vol: 90 },
  { key: 'temp', id: 'TEMPHELPS', name: '임시직 고용', base: 2900, vol: 12 },
  { key: 'claims', id: 'ICSA', name: '신규 실업수당', base: 232, vol: 9 },
  { key: 'nfp', id: 'PAYEMS', name: '비농업 고용', base: 158200, vol: 60 },
  { key: 'sahm', id: 'SAHMREALTIME', name: '샴룰', base: 0.21, vol: 0.04 },
];

router.get('/labor', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const stages = await Promise.all(
      LABOR_DEFS.map(async (d) => {
        let points: Pt[] = [];
        if (hasFredKey()) {
          try {
            points = await fetchFredPoints(d.id, 14);
          } catch { /* fall through */ }
        }
        if (points.length >= 2) {
          anyLive = true;
        } else {
          points = ([] as Pt[]);
        }
        return { key: d.key, id: d.id, name: d.name, points };
      }),
    );
    res.json({ stages, source: anyLive ? 'live' : 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── /consumer (3-stage) ────────────────────────────────────────────────
const CONSUMER_DEFS: Array<{ key: string; id: string; n: number; base: number; vol: number; monthly?: boolean }> = [
  { key: 'sentiment', id: 'UMCSENT', n: 18, base: 68, vol: 2.5, monthly: true },
  { key: 'savings', id: 'PSAVERT', n: 64, base: 4.6, vol: 0.2, monthly: true },
  { key: 'delinquency', id: 'DRCCLACBS', n: 22, base: 3.2, vol: 0.08, monthly: true },
  { key: 'retailExAuto', id: 'RSFSXMV', n: 16, base: 248000, vol: 1200, monthly: true },
  { key: 'cpi', id: 'CPIAUCSL', n: 16, base: 313, vol: 0.4, monthly: true },
];

router.get('/consumer', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const out: Record<string, { points: Pt[] }> = {};
    let anyLive = false;
    await Promise.all(
      CONSUMER_DEFS.map(async (d) => {
        let points: Pt[] = [];
        if (hasFredKey()) {
          try {
            points = await fetchFredPoints(d.id, d.n);
          } catch { /* fall through */ }
        }
        if (points.length >= 2) {
          anyLive = true;
        } else {
          points = d.id === 'DRCCLACBS' ? ([] as Pt[]) : ([] as Pt[]);
        }
        out[d.key] = { points };
      }),
    );
    res.json({
      sentiment: out.sentiment,
      savings: out.savings,
      delinquency: out.delinquency,
      retailExAuto: out.retailExAuto,
      cpi: out.cpi,
      source: anyLive ? 'live' : 'dummy',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
