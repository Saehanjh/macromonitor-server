import { Router, Request, Response, NextFunction } from 'express';
import { config, hasFredKey } from '../config';
import { proxyFetch } from '../services/proxyFetch';

const router = Router();
type Pt = { t: number; v: number };

// ── normalized auction record ──────────────────────────────────────────
type AuctionType = 'Bill' | 'Note' | 'Bond' | 'TIPS' | 'FRN';
interface Auction {
  cusip: string;
  type: AuctionType;
  term: string; // e.g. "10-Year", "4-Week"
  auctionDate: string; // ISO yyyy-mm-dd
  issueDate: string; // ISO yyyy-mm-dd
  offeringAmount: number | null; // $B
  bidToCover: number | null;
  highYield: number | null; // % (yield/rate/discount depending on type)
  interestRate: number | null; // coupon % if any
  upcoming: boolean;
}

// ── TreasuryDirect raw shapes (loose) ──────────────────────────────────
interface TdSecurity {
  cusip?: string;
  securityType?: string; // "Bill" | "Note" | "Bond" | "TIPS" | "FRN" | "CMB"
  securityTerm?: string;
  auctionDate?: string;
  issueDate?: string;
  offeringAmount?: string;
  totalAccepted?: string;
  bidToCoverRatio?: string;
  highYield?: string;
  highDiscountRate?: string;
  highInvestmentRate?: string;
  interestRate?: string;
  spread?: string;
}

function normType(raw?: string): AuctionType {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('tips') || s.includes('inflation')) return 'TIPS';
  if (s.includes('frn') || s.includes('floating')) return 'FRN';
  if (s.includes('bill') || s.includes('cmb')) return 'Bill';
  if (s.includes('bond')) return 'Bond';
  return 'Note';
}

function isoDate(raw?: string): string {
  if (!raw) return '';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

function numOrNull(raw?: string): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toBillions(raw?: string): number | null {
  const n = numOrNull(raw);
  if (n == null) return null;
  return Number((n / 1e9).toFixed(2));
}

function normalizeAuction(s: TdSecurity, upcoming: boolean): Auction | null {
  const type = normType(s.securityType);
  const auctionDate = isoDate(s.auctionDate);
  if (!auctionDate) return null;
  // yield: bills report discount/investment rate, coupons report highYield
  const hy =
    numOrNull(s.highYield) ??
    numOrNull(s.highInvestmentRate) ??
    numOrNull(s.highDiscountRate);
  return {
    cusip: s.cusip ?? '',
    type,
    term: s.securityTerm ?? type,
    auctionDate,
    issueDate: isoDate(s.issueDate),
    offeringAmount: toBillions(s.offeringAmount) ?? toBillions(s.totalAccepted),
    bidToCover: numOrNull(s.bidToCoverRatio),
    highYield: hy,
    interestRate: numOrNull(s.interestRate),
    upcoming,
  };
}

async function fetchTd(path: string, key: string): Promise<TdSecurity[]> {
  const url = `https://www.treasurydirect.gov/TA_WS/securities/${path}`;
  const r = await proxyFetch<TdSecurity[]>({ key, url, ttlSec: config.cache.macro });
  return Array.isArray(r.data) ? r.data : [];
}

// ── dummy auction generator ────────────────────────────────────────────
const DUMMY_PLAN: Array<{ type: AuctionType; term: string; amt: number; dayOffset: number }> = [
  { type: 'Bill', term: '4-Week', amt: 80, dayOffset: -2 },
  { type: 'Bill', term: '8-Week', amt: 75, dayOffset: -2 },
  { type: 'Bill', term: '13-Week', amt: 76, dayOffset: -4 },
  { type: 'Bill', term: '26-Week', amt: 70, dayOffset: -4 },
  { type: 'Note', term: '2-Year', amt: 69, dayOffset: -6 },
  { type: 'Note', term: '5-Year', amt: 70, dayOffset: -5 },
  { type: 'Note', term: '7-Year', amt: 44, dayOffset: -3 },
  { type: 'Note', term: '10-Year', amt: 42, dayOffset: 1 },
  { type: 'Bond', term: '30-Year', amt: 25, dayOffset: 3 },
  { type: 'TIPS', term: '10-Year', amt: 18, dayOffset: 5 },
  { type: 'FRN', term: '2-Year', amt: 28, dayOffset: 7 },
  { type: 'Bill', term: '52-Week', amt: 48, dayOffset: 9 },
];

function dummyAuctions(): Auction[] {
  const today = new Date();
  return DUMMY_PLAN.map((p, i) => {
    const aDate = new Date(today);
    aDate.setDate(today.getDate() + p.dayOffset);
    const iDate = new Date(aDate);
    iDate.setDate(aDate.getDate() + 2);
    const upcoming = p.dayOffset > 0;
    return {
      cusip: `DUMMY${String(i).padStart(4, '0')}`,
      type: p.type,
      term: p.term,
      auctionDate: aDate.toISOString().slice(0, 10),
      issueDate: iDate.toISOString().slice(0, 10),
      offeringAmount: p.amt,
      bidToCover: upcoming ? null : Number((2.2 + Math.random() * 0.7).toFixed(2)),
      highYield: upcoming ? null : Number((3.8 + Math.random() * 0.9).toFixed(3)),
      interestRate: p.type === 'Bill' ? null : Number((3.5 + Math.random() * 0.8).toFixed(3)),
      upcoming,
    };
  });
}

// ── GET /auctions ──────────────────────────────────────────────────────
router.get('/auctions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 60));
    let source: 'live' | 'dummy' = 'dummy';
    let auctions: Auction[] = [];

    try {
      const [auctioned, upcoming] = await Promise.all([
        fetchTd(`auctioned?format=json&days=${days}`, `td:auctioned:${days}`),
        fetchTd('upcoming?format=json', 'td:upcoming'),
      ]);
      const merged = [
        ...auctioned.map((s) => normalizeAuction(s, false)),
        ...upcoming.map((s) => normalizeAuction(s, true)),
      ].filter((a): a is Auction => a !== null);
      if (merged.length) {
        // de-dup by cusip+auctionDate, upcoming flag preferred from auctioned
        const seen = new Map<string, Auction>();
        for (const a of merged) {
          const k = `${a.cusip}|${a.auctionDate}`;
          if (!seen.has(k) || !a.upcoming) seen.set(k, a);
        }
        auctions = [...seen.values()].sort((x, y) => x.auctionDate.localeCompare(y.auctionDate));
        source = 'live';
      }
    } catch {
      /* dummy fallback */
    }

    if (!auctions.length) auctions = dummyAuctions();
    res.json({ auctions, source });
  } catch (err) {
    next(err);
  }
});

// ── FRED weekly helper ─────────────────────────────────────────────────
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
  const r = await proxyFetch<FredResp>({ key: `fred:${id}:plumb:${limit}`, url, ttlSec: config.cache.macro });
  return (r.data.observations ?? [])
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ t: Math.floor(Date.parse(o.date) / 1000), v: Number(o.value) }))
    .filter((p) => Number.isFinite(p.v))
    .reverse();
}

function synthWeekly(base: number, n: number, vol: number, drift = 0): Pt[] {
  const now = Math.floor(Date.now() / 1000);
  const week = 604800;
  const out: Pt[] = [];
  let v = base;
  for (let i = n - 1; i >= 0; i--) {
    v = Math.max(base * 0.3, v + (Math.random() - 0.5) * vol + drift);
    out.push({ t: now - i * week, v: Number(v.toFixed(1)) });
  }
  return out;
}

// ── GET /plumbing ──────────────────────────────────────────────────────
// WALCL/WTREGEN in $millions on FRED; convert to $B. RRPONTSYD in $B already.
router.get('/plumbing', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const N = 104; // ~2 years weekly
    let source: 'live' | 'dummy' = 'dummy';

    // dummy ($B)
    let walcl = synthWeekly(7100, N, 30, -8); // Fed balance sheet, QT drift down
    let tga = synthWeekly(760, N, 60);
    let rrp = synthWeekly(440, N, 40, -3);
    let resb = synthWeekly(3300, N, 50);

    if (hasFredKey()) {
      try {
        const [w, t, r, b] = await Promise.all([
          fetchFredPoints('WALCL', N).then((p) => p.map((x) => ({ t: x.t, v: x.v / 1000 }))), // $M → $B
          fetchFredPoints('WTREGEN', N).then((p) => p.map((x) => ({ t: x.t, v: x.v / 1000 }))), // $M → $B
          fetchFredPoints('RRPONTSYD', N * 5), // daily; already $B
          fetchFredPoints('WRESBAL', N).then((p) => p.map((x) => ({ t: x.t, v: x.v / 1000 }))), // $M → $B
        ]);
        if (w.length) { walcl = w; source = 'live'; }
        if (t.length) tga = t;
        if (r.length) {
          // collapse daily RRP to weekly (last per ISO week) to align cadence
          const byWeek = new Map<string, Pt>();
          for (const p of r) {
            const d = new Date(p.t * 1000);
            const wk = `${d.getUTCFullYear()}-${Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 604800000))}`;
            byWeek.set(wk, p); // later overwrites → last of week
          }
          rrp = [...byWeek.values()].sort((a, b) => a.t - b.t).slice(-N);
        }
        if (b.length) resb = b;
      } catch {
        /* dummy */
      }
    }

    res.json({
      walcl: { points: walcl },
      tga: { points: tga },
      rrp: { points: rrp },
      reserves: { points: resb },
      source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
