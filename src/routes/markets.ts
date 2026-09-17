import { requireRealMacroData } from '../middleware/realMacroData';
import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { zscore, pctChange } from '../services/stats';

const router = Router();
router.use(requireRealMacroData);

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
  available?: boolean;
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

const UNAVAILABLE_VOL: Record<Metric, VolMetric> = {
  vix: { key: 'vix', label: 'VIX', value: null, change: null, zscore: null, level: 'warn', zLevel: 'warn', available: false },
  move: { key: 'move', label: 'MOVE', value: null, change: null, zscore: null, level: 'warn', zLevel: 'warn', available: false },
};

async function volatilitySeries(metric: Metric, range: string, interval = '1d'): Promise<Series> {
  try {
    const series = await fetchYahoo(SYMBOLS[metric], range, interval);
    if (series.v.length >= 2) return series;
  } catch { /* FRED is an independent source for VIX daily closing values. */ }
  if (metric === 'vix' && hasFredKey()) {
    const limit = { '1mo': 23, '3mo': 66, '6mo': 130, '1y': 260, '2y': 520 }[range] ?? 130;
    const points = await fetchFredPoints('VIXCLS', limit);
    return { t: points.map(p => p.t), v: points.map(p => p.v) };
  }
  return { t: [], v: [] };
}

router.get('/volatility', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let anyLive = false;
    const metrics = {} as Record<Metric, VolMetric>;

    for (const m of Object.keys(SYMBOLS) as Metric[]) {
      try {
        const series = await volatilitySeries(m, '6mo');
        if (series.v.length >= 2) {
          metrics[m] = buildMetric(m, series);
          anyLive = true;
        } else {
          metrics[m] = UNAVAILABLE_VOL[m];
        }
      } catch {
        metrics[m] = UNAVAILABLE_VOL[m];
      }
    }

    const available = Object.values(metrics).filter(m => m.available !== false);
    const overall = worst(...available.flatMap(m => [m.level, m.zLevel]));
    const partial = available.length < 2;
    const verdict = VERDICT[overall];

    res.setHeader('X-Cache', anyLive ? 'fresh' : 'dummy');
    res.json({
      vix: metrics.vix,
      move: metrics.move,
      verdict: verdict.verdict,
      verdictLabel: partial ? `${verdict.label} (일부 지표 확인 불가)` : verdict.label,
      verdictLevel: overall,
      asOf: new Date().toISOString(),
      source: anyLive ? (partial ? 'partial' : 'live') : 'dummy',
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
router.get('/plumbing', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!hasFredKey()) {
      res.status(503).json({ error: 'fred_key_missing', message: '서버에 FRED API 키를 설정해야 실제 유동성 지표를 확인할 수 있습니다.' });
      return;
    }
    const ids = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'WRESBAL', 'SOFR', 'IORB', 'WLCFLPCL', 'STLFSI4', 'DRTSCILM', 'DRCRELEXFACBS', 'BAMLH0A3HYC'];
    const entries = await Promise.all(ids.map(async id => [id, await fetchFredPoints(id, 10).catch(() => [] as Pt[])] as const));
    const series = Object.fromEntries(entries);
    const latest = (id: string): number | null => series[id]?.at(-1)?.v ?? null;
    let availableCount = 0;
    const indicator = (key: string, label: string, value: number | null, unit: string, hint: string, status: Level = 'ok') => {
      const available = value != null && Number.isFinite(value);
      if (available) availableCount++;
      return { key, label, value: available ? value.toFixed(2) : '확인 불가', available, unit, status: available ? status : 'warn' as Level, hint: available ? hint : `${hint} · 실제 데이터 확인 불가` };
    };
    const w = latest('WALCL'), t = latest('WTREGEN'), r = latest('RRPONTSYD'), b = latest('WRESBAL');
    const prevB = series.WRESBAL?.at(-5)?.v ?? null;
    const reserveChange = b != null && prevB != null && prevB !== 0 ? (b / prevB - 1) * 100 : null;
    const sofr = latest('SOFR'), iorb = latest('IORB');
    const spread = sofr != null && iorb != null ? (sofr - iorb) * 100 : null;
    const groups = [
      { key: 'centralBank', title: '중앙은행 유동성', indicators: [
        indicator('dynamicLiquidity', '순유동성', w != null && t != null && r != null ? w / 1000 - t / 1000 - r : null, 'B', 'FRED WALCL−WTREGEN−RRPONTSYD · 최근 발표치'),
        indicator('reserveDrain', '지급준비금 4주 변화', reserveChange, '%/4w', 'FRED WRESBAL', reserveChange != null && reserveChange < -2 ? 'warn' : 'ok'),
        indicator('reserveBuffer', 'Reserves + ON RRP 버퍼', b != null && r != null ? b / 1000 + r : null, 'B', 'FRED WRESBAL + RRPONTSYD'),
      ] },
      { key: 'funding', title: '단기자금시장', indicators: [
        indicator('sofrIorb', 'SOFR – IORB', spread, 'bp', 'FRED SOFR−IORB', spread != null && spread > 10 ? 'warn' : 'ok'),
        indicator('emergencyLending', 'Primary Credit 잔액', latest('WLCFLPCL') == null ? null : latest('WLCFLPCL')! / 1000, 'B', 'FRED WLCFLPCL'),
        indicator('srfUsage', 'SRF Usage', null, 'B', 'NY Fed 제공처 미연결'),
        indicator('pdNetPosition', 'PD Net Position', null, 'B', 'NY Fed 제공처 미연결'),
      ] },
      { key: 'globalDollar', title: '글로벌 달러·환율', indicators: [
        indicator('financialStress', '금융스트레스(STLFSI)', latest('STLFSI4'), '', 'FRED STLFSI4', (latest('STLFSI4') ?? 0) > 0 ? 'warn' : 'ok'),
      ] },
      { key: 'credit', title: '신용·실물 리스크', indicators: [
        indicator('sloos', 'SLOOS(C&I 대출기준 강화)', latest('DRTSCILM'), 'net%', 'FRED DRTSCILM'),
        indicator('creRisk', 'CRE 연체율', latest('DRCRELEXFACBS'), '%', 'FRED DRCRELEXFACBS'),
        indicator('cccHy', 'CCC HY OAS', latest('BAMLH0A3HYC'), '%', 'FRED BAMLH0A3HYC'),
        indicator('sovereignCds', 'Sovereign CDS', null, '', '별도 시장 데이터 제공처 미연결'),
      ] },
    ].map(group => ({ ...group, status: worst(...group.indicators.map(i => i.status)) }));
    res.json({ groups: availableCount ? groups : [], source: availableCount ? 'partial' : 'dummy', coverage: { available: availableCount, total: groups.reduce((sum, group) => sum + group.indicators.length, 0) } });
  } catch (error) { next(error); }
});

// ── History (라인차트 데이터) ──────────────────────────────────────────
const RANGE_MAP: Record<string, { range: string; interval: string }> = {
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '2Y': { range: '2y', interval: '1wk' },
};



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
      const series = await volatilitySeries(metric, range, interval);
      if (series.v.length > 0) {
        const points = series.t.map((t, i) => ({ t, v: Number(series.v[i].toFixed(2)) }));
        res.setHeader('X-Cache', 'fresh');
        res.json({ metric, range: rangeKey, points, source: 'live' });
        return;
      }
    } catch {
      /* input remains unavailable */
    }

    const base = metric === 'vix' ? 16 : 95;
    const vol = metric === 'vix' ? 1.6 : 6;
    const count = { '1M': 22, '3M': 64, '6M': 128, '1Y': 252, '2Y': 104 }[rangeKey] ?? 64;
    res.setHeader('X-Cache', 'dummy');
    res.json({ metric, range: rangeKey, points: ([] as Array<{ t: number; v: number }>), source: 'dummy' });
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



// ── /capital-migration ─────────────────────────────────────────────────
// TODO(FRED): DFII10 (TIPS 10Y real) + MMMFFAQ027S (MMF total assets).
router.get('/capital-migration', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let source: 'live' | 'dummy' = 'dummy';
    let tips = ([] as Array<{ t: number; v: number }>);
    let mmf = ([] as Array<{ t: number; v: number }>);
    let vix = Number.NaN;

    if (hasFredKey()) {
      try {
        const t = await fetchFredPoints('DFII10', 200);
        if (t.length) { tips = t; source = 'live'; }
      } catch { /* input remains unavailable */ }
      try {
        const m = await fetchFredPoints('MMMFFAQ027S', 40);
        if (m.length) { mmf = m; source = 'live'; }
      } catch { /* input remains unavailable */ }
    }

    try {
      const v = await fetchYahooFull('^VIX', '5d');
      if (v.closes.length) vix = Number(v.closes[v.closes.length - 1].toFixed(2));
    } catch { /* input remains unavailable */ }

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

function unavailableSector(symbol: string, name: string) {
  return {
    symbol,
    name,
    closes: ([] as number[]),
    volumes: ([] as number[]),
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
        return unavailableSector(s.symbol, s.name);
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
      return { closes: ([] as number[]), volumes: ([] as number[]) };
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
    let netLiquidity: Pt[] = ([] as Array<{ t: number; v: number }>);
    let components = { walcl: Number.NaN, tga: Number.NaN, rrp: Number.NaN }; // raw FRED units ($M,$M,$B)
    let sp500: Pt[] = ([] as Array<{ t: number; v: number }>);

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
      } catch { /* input remains unavailable */ }
    }

    try {
      const g = await fetchYahooFull('^GSPC', '1y', '1wk');
      if (g.closes.length) {
        sp500 = g.t.map((t, i) => ({ t, v: Number(g.closes[i].toFixed(2)) })).slice(-52);
      }
    } catch { /* input remains unavailable */ }

    if (!sp500.length && hasFredKey()) {
      const daily = await fetchFredPoints('SP500', 270).catch(() => [] as Pt[]);
      const weekly = new Map<number, Pt>();
      daily.forEach(point => weekly.set(Math.floor(point.t / 604800), point));
      sp500 = [...weekly.values()].slice(-52);
    }

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
    let mmfRetail: Pt[] = ([] as Array<{ t: number; v: number }>);
    // institutional MMF: weekly FRED series (WIMFSL/IMFSL) were discontinued in 2021.
    // Derive it from real data: total MMF (MMMFFAQ027S) − retail (RMFSL).
    let mmfInst: Pt[] = ([] as Array<{ t: number; v: number }>);
    let instNote = 'FRED 데이터를 가져오지 못했습니다.';
    let deposits: Pt[] = ([] as Array<{ t: number; v: number }>);

    if (hasFredKey()) {
      let retail: Pt[] = [];
      try {
        retail = await fetchFredPoints('RMFSL', 18); // retail money funds, $B, monthly
        if (retail.length) { mmfRetail = retail; source = 'live'; }
      } catch { /* input remains unavailable */ }

      try {
        // MMMFFAQ027S = total MMF financial assets, $millions, quarterly → $B
        const totalQ = (await fetchFredPoints('MMMFFAQ027S', 16)).map((p) => ({ t: p.t, v: p.v / 1000 }));
        if (totalQ.length && retail.length) {
          // forward-fill the quarterly total onto retail's monthly timestamps,
          // then institutional = total − retail (retail + inst === total exactly)
          const derived = retail
            .map((r) => {
              const tot = forwardFill(totalQ, r.t);
              return tot != null ? { t: r.t, v: Number(Math.max(0, tot - r.v).toFixed(1)) } : null;
            })
            .filter((p): p is Pt => p !== null);
          if (derived.length) {
            mmfInst = derived;
            instNote = 'FRED 파생: 총계(MMMFFAQ027S)−소매(RMFSL)';
            source = 'live';
          }
        }
      } catch { /* input remains unavailable */ }

      try {
        const d = await fetchFredPoints('DPSACBW027SBOG', 18);
        if (d.length) { deposits = d; source = 'live'; }
      } catch { /* input remains unavailable */ }
    }

    res.json({
      mmfRetail: { points: mmfRetail },
      mmfInst: { points: mmfInst, note: instNote },
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
    let rrp: Pt[] = ([] as Array<{ t: number; v: number }>);
    let sofr: Pt[] = ([] as Array<{ t: number; v: number }>);

    if (hasFredKey()) {
      try {
        const r = await fetchFredPoints('RRPONTSYD', 25);
        if (r.length) { rrp = r; source = 'live'; }
      } catch { /* input remains unavailable */ }
      try {
        const s = await fetchFredPoints('SOFR', 35);
        if (s.length) { sofr = s; source = 'live'; }
      } catch { /* input remains unavailable */ }
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
function unavailableRate(): Pt[] { return []; }

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
          series[s] = unavailableRate();
        }
      }
      source = anyLive ? 'live' : 'dummy';
    } else {
      for (const s of RATE_SERIES) series[s] = unavailableRate();
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
  if (!points.length) return { value: null, change: null, available: false, level: 'warn' as Level, points: [] as Pt[] };
  const v = points[points.length - 1].v;
  const prev = points.length > 5 ? points[points.length - 6].v : v;
  return {
    value: Number(v.toFixed(2)),
    change: Number((v - prev).toFixed(2)), // 5-obs change, in percentage points
    available: true,
    level: kind === 'hy' ? levelForHy(v) : levelForIg(v),
    points: points.slice(-130),
  };
}

router.get('/credit', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let hyPts = ([] as Array<{ t: number; v: number }>);
    let igPts = ([] as Array<{ t: number; v: number }>);
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
