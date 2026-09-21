import { Router } from 'express';
import * as cheerio from 'cheerio';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { translateBatch } from '../services/translate';

const router = Router();

type NewsCategory = 'fed' | 'bonds' | 'global' | 'tech' | 'onchain';

export interface NewsItem {
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
    // A feed item without a parseable publication time cannot be presented as recent.
    if (!Number.isFinite(ts)) return;
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

/** Fetch a bounded set of real RSS headlines for server-generated reports. */
export async function fetchLatestNews(limit = 8, maxAgeHours = 24 * 7): Promise<NewsItem[]> {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
  const seen = new Set<string>();
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .filter((item) => { const published = Date.parse(item.publishedAt); return published >= cutoff && published <= Date.now() + 5 * 60_000; })
    .filter((item) => { const key = item.title.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, Math.max(1, Math.min(20, limit)));
}

/** Translate live headlines once at the server boundary so every consumer
 * (news screen, briefings, and generated market updates) gets the same title
 * and retains the original headline for provenance. */
export async function translateNewsItems(items: NewsItem[]): Promise<NewsItem[]> {
  // Korean is the product language.  Older Render environments could still
  // carry TRANSLATE_NEWS=false from an early optional experiment, which left
  // every live headline in English despite the app requesting Korean.  Keep
  // the provider calls best-effort, but always attempt the Korean conversion.
  if (items.length === 0) return items;
  const titlesKo = await translateBatch(items.map((n) => n.title), 'ko');
  return items.map((n, i) => ({ ...n, titleEn: n.title, title: titlesKo[i] || n.title }));
}

router.get('/', async (req, res, next) => {
  try {
    const category = String(req.query.category ?? 'all') as NewsCategory | 'all';
    const window = String(req.query.window ?? 'h24');
    const windowMs = window === 'd7' ? 7 * 86_400_000 : window === 'd3' ? 3 * 86_400_000 : 86_400_000;
    const now = Date.now();

    // fetch all feeds in parallel; tolerate individual failures
    let all: NewsItem[] = await fetchLatestNews(50);

    const source = 'live';
    if (all.length === 0) {
      res.status(503).json({ error: 'news_unavailable', message: '실제 뉴스 피드를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    const cutoff = now - windowMs;
    const filtered = all.filter((n) => {
      const within = Date.parse(n.publishedAt) >= cutoff;
      const matches = category === 'all' || n.category === category;
      // live feeds: keep even if slightly older so the list isn't empty
      return within && matches;
    });

    let items = filtered.slice(0, 50);

    // translate live English headlines to Korean (cached; best-effort)
    if (source === 'live' && items.length) items = await translateNewsItems(items);

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
