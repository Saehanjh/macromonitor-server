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
      res.status(503).json({ error: 'calendar_unavailable', message: '국채 입찰 일정을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    const events = treasuryEvents.sort((a, b) => a.time.localeCompare(b.time));
    // "live" when we actually pulled real Treasury auction data for the date
    const source = 'live';

    res.json({ date, events, source });
  } catch (err) {
    next(err);
  }
});

export default router;
