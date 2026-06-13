import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import * as cache from '../services/cache';

const router = Router();
type Pt = { t: number; v: number };

function synth(base: number, n: number, vol: number, drift = 0): number[] {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v = Math.max(base * 0.2, v + (Math.random() - 0.5) * vol + drift);
    out.push(v);
  }
  return out;
}

// ── 1) Stablecoins (CoinGecko market cap charts) ───────────────────────
interface CgChart {
  market_caps?: [number, number][];
}
const STABLE_DAYS = new Set(['30', '90', '180', '365']);

router.get('/stablecoins', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = typeof req.query.days === 'string' && STABLE_DAYS.has(req.query.days) ? req.query.days : '90';
    const base = 'https://api.coingecko.com/api/v3';
    let usdt: [number, number][] = [];
    let usdc: [number, number][] = [];
    let source: 'live' | 'dummy' = 'dummy';

    try {
      const [a, b] = await Promise.all([
        proxyFetch<CgChart>({
          key: `onchain:cg:tether:${days}`,
          url: `${base}/coins/tether/market_chart?vs_currency=usd&days=${days}&interval=daily`,
          ttlSec: config.cache.stable,
        }),
        proxyFetch<CgChart>({
          key: `onchain:cg:usd-coin:${days}`,
          url: `${base}/coins/usd-coin/market_chart?vs_currency=usd&days=${days}&interval=daily`,
          ttlSec: config.cache.stable,
        }),
      ]);
      usdt = a.data.market_caps ?? [];
      usdc = b.data.market_caps ?? [];
      if (usdt.length && usdc.length) source = 'live';
    } catch { /* fall through to dummy */ }

    if (!usdt.length || !usdc.length) {
      const n = Number(days);
      const now = Date.now();
      const day = 86400_000;
      const u = synth(118e9, n, 4e8, 1.5e8);
      const c = synth(34e9, n, 2e8, 1.2e8);
      usdt = u.map((v, i) => [now - (n - 1 - i) * day, v]);
      usdc = c.map((v, i) => [now - (n - 1 - i) * day, v]);
      source = 'dummy';
    }

    const n = Math.min(usdt.length, usdc.length);
    const series: Array<{ t: number; total: number; dominance: number }> = [];
    for (let i = 0; i < n; i++) {
      const u = usdt[i][1];
      const c = usdc[i][1];
      const sum = u + c;
      series.push({
        t: Math.floor(usdt[i][0] / 1000),
        total: Number((sum / 1e9).toFixed(2)),
        dominance: Number((sum ? (c / sum) * 100 : 0).toFixed(2)),
      });
    }

    res.json({ series, latest: series[series.length - 1] ?? null, source });
  } catch (err) {
    next(err);
  }
});

// ── 2) RWA (DefiLlama) ─────────────────────────────────────────────────
interface Protocol {
  name: string;
  category?: string;
  tvl?: number;
  slug?: string;
}
interface ProtoDetail {
  tvl?: Array<{ date: number; totalLiquidityUSD: number }>;
}
const TBILL_KW = ['ondo', 'hashnote', 'openeden', 'backed', 'franklin', 'buidl', 'superstate', 'mountain', 'usdy', 'treasur', 't-bill', 'blackrock', 'm^0', 'maple', 'usual'];

function monthKey(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

async function buildRwaHistory(slugs: string[]): Promise<Pt[]> {
  const now = Date.now() / 1000;
  const twoYrAgo = now - 2 * 365 * 86400;
  const monthMap = new Map<number, number>();
  for (const slug of slugs) {
    try {
      const r = await proxyFetch<ProtoDetail>({
        key: `dl:protocol:${slug}`,
        url: `https://api.llama.fi/protocol/${encodeURIComponent(slug)}`,
        ttlSec: config.cache.rwa,
      });
      const perMonth = new Map<number, number>();
      for (const pt of r.data.tvl ?? []) {
        if (pt.date < twoYrAgo) continue;
        perMonth.set(monthKey(pt.date), pt.totalLiquidityUSD);
      }
      for (const [mk, v] of perMonth) monthMap.set(mk, (monthMap.get(mk) ?? 0) + v);
    } catch { /* skip protocol */ }
  }
  return [...monthMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mk, v]) => ({ t: mk, v: Number((v / 1e9).toFixed(3)) }));
}

function dummyRwaHistory(): Pt[] {
  const now = Math.floor(Date.now() / 1000);
  const month = 2_629_800;
  const out: Pt[] = [];
  let v = 2.1;
  for (let i = 23; i >= 0; i--) {
    v = Math.max(1, v + (Math.random() - 0.3) * 0.4);
    out.push({ t: now - i * month, v: Number(v.toFixed(3)) });
  }
  return out;
}

function dummyRwaResponse() {
  const names = ['Ondo Finance', 'Hashnote', 'BlackRock BUIDL', 'Franklin OnChain', 'Superstate', 'OpenEden', 'Backed', 'Maple', 'USUAL', 'Mountain'];
  const tvls = [620e6, 510e6, 480e6, 410e6, 260e6, 210e6, 160e6, 140e6, 120e6, 90e6];
  const cat = tvls.reduce((a, b) => a + b, 0);
  return {
    categoryTvl: Number(cat.toFixed(0)),
    tBillTvl: Number((cat * 0.72).toFixed(0)),
    protocols: names.map((name, i) => ({ rank: i + 1, name, tvl: Number(tvls[i].toFixed(0)), share: Number(((tvls[i] / cat) * 100).toFixed(1)), slug: name.toLowerCase().replace(/\s+/g, '-') })),
    history: dummyRwaHistory(),
    source: 'dummy' as const,
  };
}

router.get('/rwa', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let protocols: Protocol[] = [];
    try {
      const r = await proxyFetch<Protocol[]>({ key: 'dl:protocols', url: 'https://api.llama.fi/protocols', ttlSec: config.cache.rwa });
      protocols = Array.isArray(r.data) ? r.data : [];
    } catch { /* dummy below */ }

    const rwa = protocols
      .filter((p) => p.category === 'RWA' && typeof p.tvl === 'number' && p.tvl > 0)
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

    if (rwa.length === 0) {
      res.json(dummyRwaResponse());
      return;
    }

    const categoryTvl = rwa.reduce((s, p) => s + (p.tvl ?? 0), 0);
    const top = rwa.slice(0, 10).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      tvl: Number((p.tvl ?? 0).toFixed(0)),
      share: Number((((p.tvl ?? 0) / categoryTvl) * 100).toFixed(1)),
      slug: p.slug,
    }));
    const tBillTvl = rwa
      .filter((p) => TBILL_KW.some((k) => p.name.toLowerCase().includes(k)))
      .reduce((s, p) => s + (p.tvl ?? 0), 0);

    const slugs = top.slice(0, 6).map((t) => t.slug).filter((s): s is string => !!s);
    let history = await buildRwaHistory(slugs);
    if (history.length < 2) history = dummyRwaHistory();

    res.json({
      categoryTvl: Number(categoryTvl.toFixed(0)),
      tBillTvl: Number(tBillTvl.toFixed(0)),
      protocols: top,
      history,
      source: 'live',
    });
  } catch (err) {
    next(err);
  }
});

// ── 3) BTC spot ETF flows (Farside HTML parse + cache fallback) ─────────
function parseFarsideNum(s: string): number | null {
  if (!s || s === '-') return 0;
  let neg = false;
  let x = s.replace(/,/g, '').trim();
  if (x.startsWith('(') && x.endsWith(')')) { neg = true; x = x.slice(1, -1); }
  if (x.startsWith('-')) { neg = true; x = x.slice(1); }
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Farside is Cloudflare-protected (blocks server-side axios via TLS fingerprint),
// so we fetch through Jina AI Reader which renders the page to a markdown table:
//   | 26 May 2026 | (192.4) | ... | (333.6) |   ← last column = Total net flow
function parseFarsideMarkdown(text: string): Array<{ t: number; flow: number }> {
  const rows: Array<{ t: number; flow: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.includes('|')) continue;
    const parts = line.split('|').map((c) => c.trim());
    while (parts.length && parts[0] === '') parts.shift();
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    if (parts.length < 3) continue;
    const m = /^(\d{1,2})\s+(\w{3})\s+(\d{4})$/.exec(parts[0]);
    if (!m) continue;
    const t = Math.floor(Date.parse(`${m[1]} ${m[2]} ${m[3]}`) / 1000);
    if (!Number.isFinite(t)) continue;
    const flow = parseFarsideNum(parts[parts.length - 1]); // Total column
    if (flow != null) rows.push({ t, flow });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

function dummyEtf(): Array<{ t: number; flow: number }> {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: Array<{ t: number; flow: number }> = [];
  for (let i = 39; i >= 0; i--) {
    const flow = Math.round((Math.random() - 0.35) * 500);
    out.push({ t: now - i * day, flow });
  }
  return out;
}

router.get('/btc-etf', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const PARSED_KEY = 'onchain:farside:parsed';
    let daily: Array<{ t: number; flow: number }> = [];
    let source: 'live' | 'cache' | 'dummy' = 'dummy';

    try {
      const r = await proxyFetch<string>({
        key: 'onchain:farside:md',
        url: 'https://r.jina.ai/https://farside.co.uk/btc/',
        ttlSec: config.cache.etf,
        axiosConfig: {
          responseType: 'text',
          timeout: 30_000, // Jina renders the page, so allow more time
          headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' },
        },
      });
      const parsed = parseFarsideMarkdown(r.data);
      if (parsed.length >= 5) {
        daily = parsed;
        cache.set(PARSED_KEY, parsed, config.cache.etf, config.cache.staleGrace);
        source = 'live';
      }
    } catch { /* fall through */ }

    if (daily.length === 0) {
      const cached = cache.peek<Array<{ t: number; flow: number }>>(PARSED_KEY);
      if (cached && cached.length) {
        daily = cached;
        source = 'cache';
      }
    }
    if (daily.length === 0) {
      daily = dummyEtf();
      source = 'dummy';
    }

    let cum = 0;
    const cumulative: Pt[] = daily.map((d) => {
      cum += d.flow;
      return { t: d.t, v: Number((cum / 1000).toFixed(3)) }; // $B
    });

    res.json({
      daily: daily.map((d) => ({ t: d.t, v: Number(d.flow.toFixed(1)) })), // $M
      cumulative,
      cumulativeNow: cumulative.length ? cumulative[cumulative.length - 1].v : 0,
      source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
