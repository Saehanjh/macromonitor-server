import { requireRealMacroData } from '../middleware/realMacroData';
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import * as cache from '../services/cache';

const router = Router();
router.use(requireRealMacroData);
type Pt = { t: number; v: number };



// ── 1) Stablecoins (CoinGecko market cap charts) ───────────────────────
interface CgChart {
  market_caps?: [number, number][];
}
const STABLE_DAYS = new Set(['30', '90', '180', '365']);
const LLAMA_STABLECOINS_BASE = 'https://stablecoins.llama.fi';
const STABLECOIN_IDS = { usdt: 1, usdc: 2 } as const;

interface LlamaStablecoinChartPoint {
  date?: number;
  totalCirculatingUSD?: number;
  totalCirculating?: number;
  circulating?: number | { peggedUSD?: number };
}

function llamaCirculatingValue(point: LlamaStablecoinChartPoint): number | undefined {
  const circulating = typeof point.circulating === 'number'
    ? point.circulating
    : point.circulating?.peggedUSD;
  return point.totalCirculatingUSD ?? point.totalCirculating ?? circulating;
}

export function stableSeriesFromCharts(
  usdt: LlamaStablecoinChartPoint[],
  usdc: LlamaStablecoinChartPoint[],
  days: number,
): Array<{ t: number; total: number; dominance: number }> {
  const earliest = Math.floor(Date.now() / 1000) - days * 86_400;
  const usdtByDate = new Map(usdt
    .filter((point) => Number.isFinite(point.date) && Number.isFinite(llamaCirculatingValue(point)))
    .map((point) => [point.date!, llamaCirculatingValue(point)!]));
  const usdcByDate = new Map(usdc
    .filter((point) => Number.isFinite(point.date) && Number.isFinite(llamaCirculatingValue(point)))
    .map((point) => [point.date!, llamaCirculatingValue(point)!]));
  return [...new Set([...usdtByDate.keys(), ...usdcByDate.keys()])]
    .filter((date) => date >= earliest)
    .sort((a, b) => a - b)
    .flatMap((date) => {
      const tether = usdtByDate.get(date);
      const usdCoin = usdcByDate.get(date);
      if (!Number.isFinite(tether) || !Number.isFinite(usdCoin)) return [];
      const total = tether! + usdCoin!;
      if (total <= 0) return [];
      return [{
        t: date,
        total: Number((total / 1e9).toFixed(2)),
        dominance: Number(((usdCoin! / total) * 100).toFixed(2)),
      }];
    });
}

router.get('/stablecoins', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = typeof req.query.days === 'string' && STABLE_DAYS.has(req.query.days) ? req.query.days : '90';
    const base = 'https://api.coingecko.com/api/v3';
    let usdt: [number, number][] = [];
    let usdc: [number, number][] = [];
    let source: 'live' | 'unavailable' = 'unavailable';

    // DefiLlama supplies these histories without CoinGecko's shared public
    // rate limit. It is the primary source; CoinGecko remains a fallback.
    try {
      const [tether, usdCoin] = await Promise.all([
        proxyFetch<unknown>({
          key: `onchain:llama:stablecoin:${STABLECOIN_IDS.usdt}`,
          url: `${LLAMA_STABLECOINS_BASE}/stablecoin/${STABLECOIN_IDS.usdt}`,
          ttlSec: config.cache.stable,
          // Detail histories are large because they include every chain.
          // The normal ten-second JSON timeout cuts off a valid response on
          // a cold free instance before the real series can be aggregated.
          axiosConfig: { timeout: 45_000 },
        }),
        proxyFetch<unknown>({
          key: `onchain:llama:stablecoin:${STABLECOIN_IDS.usdc}`,
          url: `${LLAMA_STABLECOINS_BASE}/stablecoin/${STABLECOIN_IDS.usdc}`,
          ttlSec: config.cache.stable,
          axiosConfig: { timeout: 45_000 },
        }),
      ]);
      // The endpoint returns either a direct history array or an object with
      // the history under `circulating`; support both documented shapes.
      const toHistory = (value: unknown): LlamaStablecoinChartPoint[] => {
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
          const record = value as {
            circulating?: unknown;
            data?: unknown;
            chainBalances?: Record<string, { tokens?: LlamaStablecoinChartPoint[] }>;
          };
          if (Array.isArray(record.circulating)) return record.circulating as LlamaStablecoinChartPoint[];
          if (Array.isArray(record.data)) return record.data as LlamaStablecoinChartPoint[];
          // DefiLlama's stablecoin detail endpoint keeps historical values per
          // chain. Aggregate the real chain observations by date to recover
          // the coin's global circulating amount.
          if (record.chainBalances) {
            const totals = new Map<number, number>();
            for (const chain of Object.values(record.chainBalances)) {
              for (const point of chain.tokens ?? []) {
                const amount = llamaCirculatingValue(point);
                if (Number.isFinite(point.date) && Number.isFinite(amount)) {
                  totals.set(point.date!, (totals.get(point.date!) ?? 0) + amount!);
                }
              }
            }
            return [...totals.entries()].map(([date, circulating]) => ({ date, circulating }));
          }
        }
        return [];
      };
      const series = stableSeriesFromCharts(toHistory(tether.data), toHistory(usdCoin.data), Number(days));
      if (series.length) {
        res.json({ series, latest: series[series.length - 1], source: 'live', provider: 'DefiLlama' });
        return;
      }
    } catch { /* use CoinGecko only when DefiLlama is temporarily unavailable */ }

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
    } catch { /* input remains unavailable */ }

    if (!usdt.length || !usdc.length) {
      // Never manufacture a market-cap chart. The macro middleware turns this
      // explicit unavailable response into the standard retryable 503 state.
      res.json({ series: [], latest: null, source: 'unavailable', provider: 'DefiLlama/CoinGecko' });
      return;
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

    res.json({ series, latest: series[series.length - 1] ?? null, source, provider: 'CoinGecko' });
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



function dummyRwaResponse() {
  return { protocols: [], history: [], source: 'dummy' as const };
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
    if (history.length < 2) history = ([] as Pt[]);

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
      daily = ([] as Array<{ t: number; flow: number }>);
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
