import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { zscore, pctChange } from '../services/stats';

const router = Router();

type Level = 'ok' | 'warn' | 'danger';

const SYMBOLS = { vix: '^VIX', move: '^MOVE' } as const;
type Metric = keyof typeof SYMBOLS;

// ── Yahoo chart payload (subset we read) ───────────────────────────────
interface YahooChartResponse {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }>;
    error?: unknown;
  };
}

interface Series {
  t: number[];
  v: number[];
}

function extractSeries(data: YahooChartResponse): Series {
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const t: number[] = [];
  const v: number[] = [];
  ts.forEach((time, i) => {
    const c = closes[i];
    if (c != null && Number.isFinite(c)) {
      t.push(time);
      v.push(c);
    }
  });
  return { t, v };
}

async function fetchYahoo(symbol: string, range: string, interval = '1d'): Promise<Series> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  const result = await proxyFetch<YahooChartResponse>({
    key: `yahoo:${symbol}:${interval}:${range}`,
    url,
    ttlSec: config.cache.price,
  });
  return extractSeries(result.data);
}

// ── Threshold logic ────────────────────────────────────────────────────
function levelForVix(v: number): Level {
  return v < 20 ? 'ok' : v < 30 ? 'warn' : 'danger';
}
function levelForMove(v: number): Level {
  return v < 110 ? 'ok' : v < 150 ? 'warn' : 'danger';
}
/** ±1.5σ → 주의(warn), ±2.0σ → 경고(danger). */
function zLevel(z: number): Level {
  const a = Math.abs(z);
  return a >= 2 ? 'danger' : a >= 1.5 ? 'warn' : 'ok';
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, danger: 2 };
function worst(...levels: Level[]): Level {
  return levels.reduce((acc, l) => (RANK[l] > RANK[acc] ? l : acc), 'ok' as Level);
}
const VERDICT: Record<Level, { verdict: string; label: string }> = {
  ok: { verdict: 'normal', label: '정상' },
  warn: { verdict: 'caution', label: '경계' },
  danger: { verdict: 'crisis', label: '위기' },
};

interface VolMetric {
  key: Metric;
  label: string;
  value: number | null;
  change: number | null;
  zscore: number | null;
  level: Level;
  zLevel: Level;
}

function buildMetric(
  key: Metric,
  series: Series,
): VolMetric {
  const { v } = series;
  const latest = v[v.length - 1];
  const prev = v[v.length - 2];
  const window60 = v.slice(-60);
  const z = zscore(latest, window60);
  const level = key === 'vix' ? levelForVix(latest) : levelForMove(latest);
  return {
    key,
    label: key.toUpperCase(),
    value: Number(latest.toFixed(2)),
    change: Number(pctChange(latest, prev).toFixed(2)),
    zscore: Number(z.toFixed(2)),
    level,
    zLevel: zLevel(z),
  };
}

// Dummy fallback (always available per project rule).
const DUMMY_VOL: Record<Metric, VolMetric> = {
  vix: { key: 'vix', label: 'VIX', value: 16.4, change: -2.1, zscore: -0.3, level: 'ok', zLevel: 'ok' },
  move: { key: 'move', label: 'MOVE', value: 98.2, change: 1.4, zscore: 0.2, level: 'ok', zLevel: 'ok' },
};

router.get('/volatility', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const metrics = {} as Record<Metric, VolMetric>;

    for (const m of Object.keys(SYMBOLS) as Metric[]) {
      try {
        const series = await fetchYahoo(SYMBOLS[m], '6mo');
        if (series.v.length >= 2) {
          metrics[m] = buildMetric(m, series);
          anyLive = true;
        } else {
          metrics[m] = DUMMY_VOL[m];
        }
      } catch {
        metrics[m] = DUMMY_VOL[m];
      }
    }

    const overall = worst(
      metrics.vix.level,
      metrics.move.level,
      metrics.vix.zLevel,
      metrics.move.zLevel,
    );
    const verdict = VERDICT[overall];

    res.setHeader('X-Cache', anyLive ? 'fresh' : 'dummy');
    res.json({
      vix: metrics.vix,
      move: metrics.move,
      verdict: verdict.verdict,
      verdictLabel: verdict.label,
      verdictLevel: overall,
      asOf: new Date().toISOString(),
      source: anyLive ? 'live' : 'dummy',
    });
  } catch (err) {
    next(err);
  }
});

// ── Pressure groups (구간별 압력) ──────────────────────────────────────
// Composite / non-FRED indicators are served as dummy first.
//
// TODO(FRED): wire each `value`/`status` from real series:
//   centralBank.dynamicLiquidity  → WALCL − RRPONTSYD − WTREGEN (normalized)
//   centralBank.reserveDrain       → WRESBAL 4w % change
//   centralBank.reserveBuffer      → WRESBAL + RRPONTSYD
//   funding.sofrIorb               → SOFR − IORB
//   funding.srfUsage               → NY Fed SRF (RPONTSYD proxy)  [non-FRED]
//   funding.pdNetPosition          → NY Fed Primary Dealer Stats  [non-FRED]
//   funding.emergencyLending       → WLCFLPCL (primary credit)
//   globalDollar.dxyMomentum       → Yahoo DX-Y.NYB momentum
//   globalDollar.financialStress   → STLFSI4
//   globalDollar.yenCarry          → Yahoo JPY=X derived
//   globalDollar.custodyFima       → WFCDA (custody) / FIMA repo
//   credit.sloos                   → DRTSCILM
//   credit.creRisk                 → DRCRELEXFACBS
//   credit.cccHy                   → BAMLH0A3HYC
//   credit.sovereignCds            → market data  [non-FRED]
interface Indicator {
  key: string;
  label: string;
  value: string;
  unit?: string;
  status: Level;
  hint?: string;
}
interface PlumbingGroup {
  key: string;
  title: string;
  status: Level;
  indicators: Indicator[];
}

const DUMMY_PLUMBING: PlumbingGroup[] = [
  {
    key: 'centralBank',
    title: '중앙은행 유동성',
    status: 'ok',
    indicators: [
      { key: 'dynamicLiquidity', label: '동적 유동성 가용지수', value: '62.4', unit: 'idx', status: 'ok', hint: 'WALCL−RRP−TGA 정규화' },
      { key: 'reserveDrain', label: '지급준비금 잠식 속도', value: '-1.8', unit: '%/4w', status: 'warn', hint: 'WRESBAL 4주 변화' },
      { key: 'reserveBuffer', label: 'Reserves + ON RRP 버퍼', value: '3.71', unit: 'T', status: 'ok', hint: 'WRESBAL + RRP' },
    ],
  },
  {
    key: 'funding',
    title: '단기자금시장',
    status: 'ok',
    indicators: [
      { key: 'sofrIorb', label: 'SOFR – IORB', value: '+3', unit: 'bp', status: 'ok', hint: '레포 압력 스프레드' },
      { key: 'srfUsage', label: 'SRF Usage', value: '0', unit: 'B', status: 'ok', hint: 'NY Fed (더미)' },
      { key: 'pdNetPosition', label: 'PD Net Position', value: '+214', unit: 'B', status: 'warn', hint: 'NY Fed (더미)' },
      { key: 'emergencyLending', label: '긴급대출 의존도', value: '낮음', status: 'ok', hint: 'WLCFLPCL' },
    ],
  },
  {
    key: 'globalDollar',
    title: '글로벌 달러·환율',
    status: 'warn',
    indicators: [
      { key: 'dxyMomentum', label: 'DXY 모멘텀', value: '+0.6', unit: '%/5d', status: 'warn', hint: 'DX-Y.NYB' },
      { key: 'financialStress', label: '금융스트레스(STLFSI)', value: '-0.42', status: 'ok', hint: 'STLFSI4' },
      { key: 'yenCarry', label: '엔캐리 청산 리스크', value: '경계', status: 'warn', hint: 'USD/JPY 변동성' },
      { key: 'custodyFima', label: 'Custody & FIMA', value: '안정', status: 'ok', hint: '커스터디 보유' },
    ],
  },
  {
    key: 'credit',
    title: '신용·실물 리스크',
    status: 'ok',
    indicators: [
      { key: 'sloos', label: 'SLOOS(C&I 태도)', value: '+8.4', unit: 'net%', status: 'warn', hint: 'DRTSCILM' },
      { key: 'creRisk', label: 'CRE Risk(연체율)', value: '1.42', unit: '%', status: 'warn', hint: 'DRCRELEXFACBS' },
      { key: 'cccHy', label: 'CCC HY OAS', value: '7.18', unit: '%', status: 'ok', hint: 'BAMLH0A3HYC' },
      { key: 'sovereignCds', label: 'Sovereign CDS', value: '안정', status: 'ok', hint: '시장 데이터(더미)' },
    ],
  },
];

router.get('/plumbing', (_req: Request, res: Response) => {
  // All-dummy for now; structure matches the future FRED-wired payload.
  res.json({ groups: DUMMY_PLUMBING, source: 'dummy' });
});

// ── History (라인차트 데이터) ──────────────────────────────────────────
const RANGE_MAP: Record<string, { range: string; interval: string }> = {
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '2Y': { range: '2y', interval: '1wk' },
};

function synthSeries(base: number, points: number, vol: number): Array<{ t: number; v: number }> {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: Array<{ t: number; v: number }> = [];
  let v = base;
  for (let i = points - 1; i >= 0; i--) {
    v = Math.max(base * 0.4, v + (Math.random() - 0.5) * vol);
    out.push({ t: now - i * day, v: Number(v.toFixed(2)) });
  }
  return out;
}

router.get('/history/:metric', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const metric = req.params.metric as Metric;
    if (!(metric in SYMBOLS)) {
      res.status(400).json({ error: 'invalid_metric', message: 'metric must be vix or move' });
      return;
    }
    const rangeKey = typeof req.query.range === 'string' && RANGE_MAP[req.query.range] ? req.query.range : '3M';
    const { range, interval } = RANGE_MAP[rangeKey];

    try {
      const series = await fetchYahoo(SYMBOLS[metric], range, interval);
      if (series.v.length > 0) {
        const points = series.t.map((t, i) => ({ t, v: Number(series.v[i].toFixed(2)) }));
        res.setHeader('X-Cache', 'fresh');
        res.json({ metric, range: rangeKey, points, source: 'live' });
        return;
      }
    } catch {
      /* fall through to dummy */
    }

    const base = metric === 'vix' ? 16 : 95;
    const vol = metric === 'vix' ? 1.6 : 6;
    const count = { '1M': 22, '3M': 64, '6M': 128, '1Y': 252, '2Y': 104 }[rangeKey] ?? 64;
    res.setHeader('X-Cache', 'dummy');
    res.json({ metric, range: rangeKey, points: synthSeries(base, count, vol), source: 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── Phase 5: Capital Migration + Institutional Fund Velocity ───────────

interface FullSeries {
  t: number[];
  closes: number[];
  volumes: number[];
}

interface YahooFullResponse {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }> };
    }>;
    error?: unknown;
  };
}

function extractFull(data: YahooFullResponse): FullSeries {
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  const closes = q?.close ?? [];
  const volumes = q?.volume ?? [];
  const out: FullSeries = { t: [], closes: [], volumes: [] };
  ts.forEach((time, i) => {
    const c = closes[i];
    if (c != null && Number.isFinite(c)) {
      out.t.push(time);
      out.closes.push(c);
      const v = volumes[i];
      out.volumes.push(v != null && Number.isFinite(v) ? v : 0);
    }
  });
  return out;
}

async function fetchYahooFull(symbol: string, range = '1mo', interval = '1d'): Promise<FullSeries> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  const result = await proxyFetch<YahooFullResponse>({
    key: `yahoo:${symbol}:${interval}:${range}`,
    url,
    ttlSec: config.cache.price,
  });
  return extractFull(result.data);
}

interface FredResp {
  observations?: Array<{ date: string; value: string }>;
}

async function fetchFredPoints(seriesId: string, limit: number): Promise<Array<{ t: number; v: number }>> {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: config.fredApiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  });
  const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
  const result = await proxyFetch<FredResp>({
    key: `fred:${seriesId}:p:${limit}`,
    url,
    ttlSec: config.cache.macro,
  });
  return (result.data.observations ?? [])
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ t: Math.floor(Date.parse(o.date) / 1000), v: Number(o.value) }))
    .filter((p) => Number.isFinite(p.v))
    .reverse(); // ascending by time
}

// ── synthetic dummy helpers ────────────────────────────────────────────
function synthPoints(base: number, n: number, vol: number, drift = 0): Array<{ t: number; v: number }> {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: Array<{ t: number; v: number }> = [];
  let v = base;
  for (let i = n - 1; i >= 0; i--) {
    v = Math.max(base * 0.3, v + (Math.random() - 0.5) * vol + drift);
    out.push({ t: now - i * day, v: Number(v.toFixed(3)) });
  }
  return out;
}
function synthArr(base: number, n: number, vol: number): number[] {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v = Math.max(base * 0.3, v + (Math.random() - 0.5) * vol);
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

// ── /capital-migration ─────────────────────────────────────────────────
// TODO(FRED): DFII10 (TIPS 10Y real) + MMMFFAQ027S (MMF total assets).
router.get('/capital-migration', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let tips = synthPoints(1.9, 120, 0.05);
    let mmf = synthPoints(5900, 24, 30, 12);
    let vix = 16.4;

    if (hasFredKey()) {
      try {
        const t = await fetchFredPoints('DFII10', 200);
        if (t.length) { tips = t; source = 'live'; }
      } catch { /* keep dummy */ }
      try {
        const m = await fetchFredPoints('MMMFFAQ027S', 40);
        if (m.length) { mmf = m; source = 'live'; }
      } catch { /* keep dummy */ }
    }

    try {
      const v = await fetchYahooFull('^VIX', '5d');
      if (v.closes.length) vix = Number(v.closes[v.closes.length - 1].toFixed(2));
    } catch { /* keep dummy vix */ }

    res.json({
      tips: { points: tips },
      mmf: { points: mmf },
      vix,
      hasFredKey: hasFredKey(),
      source,
    });
  } catch (err) {
    next(err);
  }
});

// ── /sectors (11 SPDR ETFs) ────────────────────────────────────────────
const SECTORS: Array<{ symbol: string; name: string }> = [
  { symbol: 'XLK', name: '기술' },
  { symbol: 'XLF', name: '금융' },
  { symbol: 'XLE', name: '에너지' },
  { symbol: 'XLV', name: '헬스케어' },
  { symbol: 'XLI', name: '산업' },
  { symbol: 'XLY', name: '자유소비재' },
  { symbol: 'XLP', name: '필수소비재' },
  { symbol: 'XLU', name: '유틸리티' },
  { symbol: 'XLB', name: '소재' },
  { symbol: 'XLRE', name: '부동산' },
  { symbol: 'XLC', name: '커뮤니케이션' },
];

function dummySector(symbol: string, name: string) {
  return {
    symbol,
    name,
    closes: synthArr(100 + (symbol.charCodeAt(2) % 40), 12, 1.4),
    volumes: synthArr(8_000_000, 12, 2_500_000),
  };
}

router.get('/sectors', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const sectors = await Promise.all(
      SECTORS.map(async (s) => {
        try {
          const f = await fetchYahooFull(s.symbol, '1mo');
          if (f.closes.length >= 10) {
            anyLive = true;
            return {
              symbol: s.symbol,
              name: s.name,
              closes: f.closes.slice(-12),
              volumes: f.volumes.slice(-12),
            };
          }
        } catch { /* fall through */ }
        return dummySector(s.symbol, s.name);
      }),
    );
    res.json({ sectors, source: anyLive ? 'live' : 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── /leverage (TQQQ / SQQQ / UVXY) ─────────────────────────────────────
router.get('/leverage', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const grab = async (symbol: string, closeBase: number, volBase: number) => {
      try {
        const f = await fetchYahooFull(symbol, '1mo');
        if (f.closes.length >= 6) {
          anyLive = true;
          return { closes: f.closes.slice(-12), volumes: f.volumes.slice(-12) };
        }
      } catch { /* fall through */ }
      return { closes: synthArr(closeBase, 12, closeBase * 0.03), volumes: synthArr(volBase, 12, volBase * 0.4) };
    };

    const [tqqq, sqqq, uvxy] = await Promise.all([
      grab('TQQQ', 62, 80_000_000),
      grab('SQQQ', 8, 120_000_000),
      grab('UVXY', 20, 60_000_000),
    ]);

    res.json({ tqqq, sqqq, uvxy, source: anyLive ? 'live' : 'dummy' });
  } catch (err) {
    next(err);
  }
});

// ── Phase 6: Liquidity Flow ────────────────────────────────────────────

type Pt = { t: number; v: number };

/** Last value at or before targetT (series ascending by t). */
function forwardFill(points: Pt[], targetT: number): number | null {
  let val: number | null = null;
  for (const p of points) {
    if (p.t <= targetT) val = p.v;
    else break;
  }
  return val;
}

/**
 * Net Liquidity ($B) = WALCL − TGA − ON RRP
 *   WALCL, WTREGEN are in $Millions → ÷1000 for $B; RRPONTSYD already $B.
 *   Weekly anchor = WALCL release dates; TGA/RRP forward-filled to that date.
 *   NOTE: directional approximation — verify exact unit/vintage before any trading use.
 */
function computeNetLiquidity(walcl: Pt[], tga: Pt[], rrp: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const w of walcl) {
    const tgaV = forwardFill(tga, w.t);
    const rrpV = forwardFill(rrp, w.t);
    if (tgaV == null || rrpV == null) continue;
    const nl = w.v / 1000 - tgaV / 1000 - rrpV;
    out.push({ t: w.t, v: Number(nl.toFixed(1)) });
  }
  return out;
}

// ── /liquidity-flow (① Net Liquidity Momentum) ─────────────────────────
// TODO(FRED): WALCL, WTREGEN, RRPONTSYD; Yahoo ^GSPC weekly.
router.get('/liquidity-flow', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let netLiquidity: Pt[] = synthPoints(5900, 52, 60, -8);
    let components = { walcl: 7_100_000, tga: 760_000, rrp: 420 }; // raw FRED units ($M,$M,$B)
    let sp500: Pt[] = synthPoints(5600, 52, 120, 6);

    if (hasFredKey()) {
      try {
        const [walcl, tga, rrp] = await Promise.all([
          fetchFredPoints('WALCL', 70),
          fetchFredPoints('WTREGEN', 420),
          fetchFredPoints('RRPONTSYD', 420),
        ]);
        if (walcl.length && tga.length && rrp.length) {
          const nl = computeNetLiquidity(walcl, tga, rrp).slice(-52);
          if (nl.length) {
            netLiquidity = nl;
            components = {
              walcl: walcl[walcl.length - 1].v,
              tga: tga[tga.length - 1].v,
              rrp: rrp[rrp.length - 1].v,
            };
            source = 'live';
          }
        }
      } catch { /* keep dummy */ }
    }

    try {
      const g = await fetchYahooFull('^GSPC', '1y', '1wk');
      if (g.closes.length) {
        sp500 = g.t.map((t, i) => ({ t, v: Number(g.closes[i].toFixed(2)) })).slice(-52);
      }
    } catch { /* keep dummy sp500 */ }

    res.json({
      netLiquidity: { points: netLiquidity },
      sp500: { points: sp500 },
      components,
      source,
    });
  } catch (err) {
    next(err);
  }
});

// ── /mmf-deposits (② MMF capital migration & liquidity quality) ────────
router.get('/mmf-deposits', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let mmfRetail: Pt[] = synthPoints(2350, 16, 20, 6);
    const mmfInst: Pt[] = synthPoints(4050, 16, 25, 5); // ICI (no clean FRED weekly) → dummy
    let deposits: Pt[] = synthPoints(17400, 16, 40, -5);

    if (hasFredKey()) {
      try {
        const r = await fetchFredPoints('RMFSL', 18);
        if (r.length) { mmfRetail = r; source = 'live'; }
      } catch { /* keep dummy */ }
      try {
        const d = await fetchFredPoints('DPSACBW027SBOG', 18);
        if (d.length) { deposits = d; source = 'live'; }
      } catch { /* keep dummy */ }
    }

    res.json({
      mmfRetail: { points: mmfRetail },
      mmfInst: { points: mmfInst, note: 'ICI 추정(더미)' },
      deposits: { points: deposits },
      source,
    });
  } catch (err) {
    next(err);
  }
});

// ── /repo-phase (③ private repo inflow phase) ──────────────────────────
router.get('/repo-phase', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let rrp: Pt[] = synthPoints(420, 20, 12, -3);
    let sofr: Pt[] = synthPoints(5.31, 30, 0.03);

    if (hasFredKey()) {
      try {
        const r = await fetchFredPoints('RRPONTSYD', 25);
        if (r.length) { rrp = r; source = 'live'; }
      } catch { /* keep dummy */ }
      try {
        const s = await fetchFredPoints('SOFR', 35);
        if (s.length) { sofr = s; source = 'live'; }
      } catch { /* keep dummy */ }
    }

    res.json({ rrp: { points: rrp }, sofr: { points: sofr }, source });
  } catch (err) {
    next(err);
  }
});

// ── Phase 7: Interest Rates ────────────────────────────────────────────
// Treasury constant-maturity yields. Spreads/direction computed on frontend.
const RATE_SERIES = ['DGS2', 'DGS5', 'DGS10', 'DGS30', 'DGS3MO'] as const;
const RATE_RANGE_LIMIT: Record<string, number> = {
  '1M': 23, '3M': 66, '6M': 128, '1Y': 260, '2Y': 520, '5Y': 1300,
};
const RATE_BASE: Record<string, number> = {
  DGS3MO: 5.3, DGS2: 4.7, DGS5: 4.3, DGS10: 4.25, DGS30: 4.45,
};
function dummyRate(seriesId: string, n: number): Pt[] {
  return synthPoints(RATE_BASE[seriesId] ?? 4.3, Math.min(n, 260), 0.03);
}

router.get('/rates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const range =
      typeof req.query.range === 'string' && RATE_RANGE_LIMIT[req.query.range] ? req.query.range : '1Y';
    const limit = RATE_RANGE_LIMIT[range];

    const series: Record<string, Pt[]> = {};
    let source: 'live' | 'dummy' = 'dummy';

    if (hasFredKey()) {
      const results = await Promise.all(
        RATE_SERIES.map(async (s) => {
          try {
            return [s, await fetchFredPoints(s, limit)] as const;
          } catch {
            return [s, [] as Pt[]] as const;
          }
        }),
      );
      let anyLive = false;
      for (const [s, pts] of results) {
        if (pts.length) {
          series[s] = pts;
          anyLive = true;
        } else {
          series[s] = dummyRate(s, limit);
        }
      }
      source = anyLive ? 'live' : 'dummy';
    } else {
      for (const s of RATE_SERIES) series[s] = dummyRate(s, limit);
    }

    res.json({ range, series, source });
  } catch (err) {
    next(err);
  }
});

// ── /credit (HY OAS & IG OAS credit spreads) ───────────────────────────
// HY OAS = ICE BofA US High Yield Index Option-Adjusted Spread (BAMLH0A0HYM2)
// IG OAS = ICE BofA US Corporate Index Option-Adjusted Spread (BAMLC0A0CM)
// Wider spread = investors demand more for credit risk = stress / risk-off.
function levelForHy(v: number): Level {
  return v < 4 ? 'ok' : v < 6 ? 'warn' : 'danger';
}
function levelForIg(v: number): Level {
  return v < 1.3 ? 'ok' : v < 2 ? 'warn' : 'danger';
}
function creditMetric(points: Pt[], kind: 'hy' | 'ig') {
  const v = points.length ? points[points.length - 1].v : 0;
  const prev = points.length > 5 ? points[points.length - 6].v : v;
  return {
    value: Number(v.toFixed(2)),
    change: Number((v - prev).toFixed(2)), // 5-obs change, in percentage points
    level: kind === 'hy' ? levelForHy(v) : levelForIg(v),
    points: points.slice(-130),
  };
}

router.get('/credit', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let hyPts = synthPoints(3.4, 130, 0.04);
    let igPts = synthPoints(0.95, 130, 0.012);
    let source: 'live' | 'dummy' = 'dummy';

    if (hasFredKey()) {
      const [hy, ig] = await Promise.all([
        fetchFredPoints('BAMLH0A0HYM2', 260).catch(() => [] as Pt[]),
        fetchFredPoints('BAMLC0A0CM', 260).catch(() => [] as Pt[]),
      ]);
      if (hy.length) { hyPts = hy; source = 'live'; }
      if (ig.length) { igPts = ig; source = 'live'; }
    }

    res.json({
      hy: creditMetric(hyPts, 'hy'),
      ig: creditMetric(igPts, 'ig'),
      source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
