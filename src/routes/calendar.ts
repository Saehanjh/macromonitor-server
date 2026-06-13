import { Router } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';

const router = Router();

type Impact = 'low' | 'medium' | 'high';

interface CalendarEvent {
  id: string;
  time: string;
  country: string;
  title: string;
  impact: Impact;
  forecast?: string;
  previous?: string;
  actual?: string;
}

// ── real: US Treasury auctions for the date (TreasuryDirect, no key) ────
interface TdSecurity {
  cusip?: string;
  securityType?: string;
  securityTerm?: string;
  auctionDate?: string;
  offeringAmount?: string;
  highYield?: string;
  highInvestmentRate?: string;
  highDiscountRate?: string;
}
const isoDate = (raw?: string): string => {
  if (!raw) return '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};
function billions(raw?: string): string | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? `$${(n / 1e9).toFixed(0)}B` : undefined;
}

async function treasuryEventsForDate(date: string): Promise<CalendarEvent[]> {
  const fetchTd = async (path: string, key: string): Promise<TdSecurity[]> => {
    const r = await proxyFetch<TdSecurity[]>({
      key,
      url: `https://www.treasurydirect.gov/TA_WS/securities/${path}`,
      ttlSec: config.cache.macro,
    });
    return Array.isArray(r.data) ? r.data : [];
  };
  const [auctioned, upcoming] = await Promise.all([
    fetchTd('auctioned?format=json&days=120', 'cal:td:auctioned').catch(() => []),
    fetchTd('upcoming?format=json', 'cal:td:upcoming').catch(() => []),
  ]);

  const out: CalendarEvent[] = [];
  for (const s of [...auctioned, ...upcoming]) {
    if (isoDate(s.auctionDate) !== date) continue;
    const yld = s.highYield ?? s.highInvestmentRate ?? s.highDiscountRate;
    out.push({
      id: `td-${s.cusip ?? Math.random().toString(36).slice(2)}`,
      time: '11:30',
      country: 'US',
      title: `미 국채 입찰 — ${s.securityTerm ?? s.securityType ?? 'Treasury'}`,
      impact: 'medium',
      forecast: billions(s.offeringAmount),
      actual: yld ? `${Number(yld).toFixed(3)}%` : undefined,
    });
  }
  return out;
}

// ── curated US macro release schedule (recurring, by weekday) ──────────
function curatedForDate(dateStr: string): CalendarEvent[] {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  const pool: CalendarEvent[][] = [
    [], // Sun
    [{ id: 'c-mon-1', time: '08:30', country: 'US', title: 'Chicago Fed National Activity', impact: 'low' }],
    [{ id: 'c-tue-1', time: '10:00', country: 'US', title: 'Consumer Confidence', impact: 'high' }],
    [
      { id: 'c-wed-1', time: '08:15', country: 'US', title: 'ADP 고용보고서', impact: 'medium' },
      { id: 'c-wed-2', time: '10:30', country: 'US', title: 'EIA 원유 재고', impact: 'medium' },
    ],
    [
      { id: 'c-thu-1', time: '08:30', country: 'US', title: 'Initial Jobless Claims', impact: 'medium' },
      { id: 'c-thu-2', time: '08:30', country: 'US', title: 'Core PCE / GDP (주별 변동)', impact: 'high' },
    ],
    [
      { id: 'c-fri-1', time: '08:30', country: 'US', title: 'Nonfarm Payrolls / CPI (주별 변동)', impact: 'high' },
      { id: 'c-fri-2', time: '10:00', country: 'US', title: 'ISM PMI (월초)', impact: 'high' },
    ],
    [], // Sat
  ];
  return pool[dow] ?? [];
}

router.get('/', async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const date = String(req.query.date ?? today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'bad_date', message: 'date must be YYYY-MM-DD' });
      return;
    }

    let treasuryEvents: CalendarEvent[] = [];
    try {
      treasuryEvents = await treasuryEventsForDate(date);
    } catch {
      /* fall back to curated only */
    }

    const events = [...treasuryEvents, ...curatedForDate(date)].sort((a, b) => a.time.localeCompare(b.time));
    // "live" when we actually pulled real Treasury auction data for the date
    const source = treasuryEvents.length > 0 ? 'live' : 'partial';

    res.json({ date, events, source });
  } catch (err) {
    next(err);
  }
});

export default router;
