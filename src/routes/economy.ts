import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';

const router = Router();
type Pt = { t: number; v: number };

// ── upstream helpers ───────────────────────────────────────────────────
interface YahooResp {
  chart: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
}
async function fetchYahooCloses(symbol: string, range = '2mo', interval = '1d'): Promise<number[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await proxyFetch<YahooResp>({ key: `yahoo:${symbol}:${interval}:${range}`, url, ttlSec: config.cache.price });
  const closes = r.data.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c): c is number => c != null && Number.isFinite(c));
}

interface FredResp {
  observations?: Array<{ date: string; value: string }>;
}
async function fetchFredPoints(seriesId: string, limit: number): Promise<Pt[]> {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: config.fredApiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  });
  const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
  const r = await proxyFetch<FredResp>({ key: `fred:${seriesId}:e:${limit}`, url, ttlSec: config.cache.macro });
  return (r.data.observations ?? [])
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ t: Math.floor(Date.parse(o.date) / 1000), v: Number(o.value) }))
    .filter((p) => Number.isFinite(p.v))
    .reverse();
}

function synthCloses(base: number, n: number, vol: number, drift = 0): number[] {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v = Math.max(base * 0.2, v + (Math.random() - 0.5) * vol + drift);
    out.push(Number(v.toFixed(3)));
  }
  return out;
}
function synthMonthly(base: number, n: number, mom: number): Pt[] {
  // monthly index rising ~`mom` fraction per month (for ~YoY*12 dummy)
  const now = Math.floor(Date.now() / 1000);
  const month = 2_629_800;
  const out: Pt[] = [];
  let v = base / (1 + mom) ** n;
  for (let i = n - 1; i >= 0; i--) {
    v = v * (1 + mom + (Math.random() - 0.5) * mom * 0.6);
    out.push({ t: now - i * month, v: Number(v.toFixed(3)) });
  }
  return out;
}
function synthDaily(base: number, n: number, vol: number): Pt[] {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: Pt[] = [];
  let v = base;
  for (let i = n - 1; i >= 0; i--) {
    v = Math.max(0.1, v + (Math.random() - 0.5) * vol);
    out.push({ t: now - i * day, v: Number(v.toFixed(3)) });
  }
  return out;
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
        return { symbol: c.symbol, name: c.name, closes: synthCloses(c.base, 25, c.vol, (Math.random() - 0.5) * c.vol * 0.3) };
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
          series[key] = { points: synthMonthly(def.base, 16, def.mom) };
        }
      }
    } else {
      for (const s of INFLATION) series[s.key] = { points: synthMonthly(s.base, 16, s.mom) };
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
    let bei = synthDaily(2.31, 70, 0.01);
    let fwd = synthDaily(2.38, 70, 0.01);
    let mich = synthMonthly(3.0, 14, 0).map((p) => ({ t: p.t, v: Number((2.8 + Math.random() * 0.5).toFixed(2)) }));

    if (hasFredKey()) {
      try { const b = await fetchFredPoints('T10YIE', 70); if (b.length) { bei = b; source = 'live'; } } catch { /* keep dummy */ }
      try { const f = await fetchFredPoints('T5YIFR', 70); if (f.length) { fwd = f; source = 'live'; } } catch { /* keep dummy */ }
      try { const m = await fetchFredPoints('MICH', 14); if (m.length) { mich = m; source = 'live'; } } catch { /* keep dummy */ }
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

    let gdpNow = 2.4;
    if (hasFredKey()) {
      const g = await latestVal('GDPNOW');
      if (g != null) { gdpNow = g; anyLive = true; }
    }

    const buildComposite = async (defs: typeof MFG_DEFS) => {
      const components = await Promise.all(
        defs.map(async (d) => {
          let v: number | null = null;
          if (hasFredKey()) v = await latestVal(d.id);
          const live = v != null;
          if (live) anyLive = true;
          return { name: d.name, value: Number((live ? v! : d.base).toFixed(1)), live };
        }),
      );
      const avg = components.reduce((a, c) => a + c.value, 0) / components.length;
      return { value: Number(avg.toFixed(1)), components };
    };

    const mfg = await buildComposite(MFG_DEFS);
    const svc = await buildComposite(SVC_DEFS);

    res.json({ gdpNow: Number(gdpNow.toFixed(1)), mfg, svc, source: anyLive ? 'live' : 'dummy' });
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
          points = synthDaily(d.base, 14, d.vol);
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
          points = d.id === 'DRCCLACBS' ? synthMonthly(d.base, d.n, 0.004) : synthDaily(d.base, d.n, d.vol);
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
