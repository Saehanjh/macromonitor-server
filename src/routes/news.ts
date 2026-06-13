import { Router } from 'express';
import * as cheerio from 'cheerio';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { translateBatch } from '../services/translate';

const router = Router();

type NewsCategory = 'fed' | 'bonds' | 'global' | 'tech' | 'onchain';

interface NewsItem {
  id: string;
  title: string; // Korean (translated) when available
  titleEn?: string; // original English headline
  source: string;
  url?: string;
  publishedAt: string;
  category: NewsCategory;
  highlight: boolean;
}

// ── real RSS feeds (no API key required) ───────────────────────────────
interface Feed {
  url: string;
  source: string;
  category: NewsCategory;
}
const FEEDS: Feed[] = [
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', source: 'Federal Reserve', category: 'fed' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC', category: 'fed' }, // Economy
  { url: 'http://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch', category: 'bonds' },
  { url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html', source: 'CNBC', category: 'bonds' }, // Markets
  { url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', source: 'CNBC', category: 'global' }, // World
  { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', source: 'CNBC', category: 'tech' }, // Technology
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml', source: 'CoinDesk', category: 'onchain' },
];

const HIGHLIGHT_RE =
  /\b(fed|fomc|powell|rate cut|rate hike|inflation|cpi|pce|payroll|jobless|recession|treasury|yield|etf|bitcoin|ecb|boj)\b/i;

function parseRss(xml: string, feed: Feed): NewsItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: NewsItem[] = [];
  $('item, entry').each((i, el) => {
    const node = $(el);
    const title = node.find('title').first().text().trim();
    if (!title) return;
    let url = node.find('link').first().text().trim();
    if (!url) url = node.find('link').first().attr('href') ?? '';
    const pub = node.find('pubDate, published, updated, dc\\:date').first().text().trim();
    const ts = pub ? Date.parse(pub) : NaN;
    out.push({
      id: `${feed.source}-${feed.category}-${i}`,
      title,
      source: feed.source,
      url: url || undefined,
      publishedAt: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
      category: feed.category,
      highlight: HIGHLIGHT_RE.test(title),
    });
  });
  return out;
}

async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  const r = await proxyFetch<string>({
    key: `news:rss:${feed.url}`,
    url: feed.url,
    ttlSec: config.cache.price * 5, // ~5 min
    axiosConfig: {
      responseType: 'text',
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    },
  });
  return typeof r.data === 'string' ? parseRss(r.data, feed) : [];
}

// ── curated fallback (used only if every feed fails) ───────────────────
const SEED: Omit<NewsItem, 'publishedAt'>[] = [
  { id: 'n01', title: 'Powell, "데이터 의존적 접근 유지" 발언… 시장은 동결 가능성 반영', source: 'Reuters', category: 'fed', highlight: true },
  { id: 'n02', title: 'NY Fed RRP 잔고 변동 — 단기 유동성 모니터링 지속', source: 'Bloomberg', category: 'fed', highlight: true },
  { id: 'n03', title: '미 재무부 분기 차입계획 발표 — 장기물 발행 비중 주목', source: 'WSJ', category: 'bonds', highlight: false },
  { id: 'n04', title: '10년물 금리 변동성 확대, 모기지 금리 동반 상승', source: 'Reuters', category: 'bonds', highlight: false },
  { id: 'n05', title: 'BoJ 정책 정상화 경로 주시 — 엔화 흐름 변동', source: 'Nikkei', category: 'global', highlight: true },
  { id: 'n08', title: 'NVIDIA 데이터센터 수요 지속 — AI 투자 사이클 점검', source: 'CNBC', category: 'tech', highlight: false },
  { id: 'n09', title: '비트코인 현물 ETF 자금 흐름 — 기관 수요 동향', source: 'CoinDesk', category: 'onchain', highlight: true },
  { id: 'n10', title: 'USDC/USDT 시총 추이 — 온체인 달러 유동성 점검', source: 'The Block', category: 'onchain', highlight: false },
];
function seedItems(now: number): NewsItem[] {
  return SEED.map((s, i) => ({ ...s, publishedAt: new Date(now - (i * 47 + 13) * 60_000).toISOString() }));
}

router.get('/', async (req, res, next) => {
  try {
    const category = String(req.query.category ?? 'all') as NewsCategory | 'all';
    const window = String(req.query.window ?? 'h24');
    const windowMs = window === 'd7' ? 7 * 86_400_000 : window === 'd3' ? 3 * 86_400_000 : 86_400_000;
    const now = Date.now();

    // fetch all feeds in parallel; tolerate individual failures
    const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
    let all: NewsItem[] = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));

    let source: 'live' | 'dummy' = 'live';
    if (all.length === 0) {
      all = seedItems(now);
      source = 'dummy';
    }

    // de-dupe by title, newest first
    const seen = new Set<string>();
    all = all
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .filter((n) => {
        const k = n.title.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    const cutoff = now - windowMs;
    const filtered = all.filter((n) => {
      const within = Date.parse(n.publishedAt) >= cutoff;
      const matches = category === 'all' || n.category === category;
      // live feeds: keep even if slightly older so the list isn't empty
      return (source === 'dummy' ? within : true) && matches;
    });

    let items = filtered.slice(0, 50);

    // translate live English headlines to Korean (cached; best-effort)
    if (source === 'live' && config.translateNews && items.length) {
      const titlesKo = await translateBatch(items.map((n) => n.title), 'ko');
      items = items.map((n, i) => ({ ...n, titleEn: n.title, title: titlesKo[i] || n.title }));
    }

    const highlights = items.filter((n) => n.highlight).slice(0, 3);

    res.json({
      items,
      highlights,
      total: filtered.length,
      window,
      category,
      source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
