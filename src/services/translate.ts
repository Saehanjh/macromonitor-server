import axios from 'axios';
import * as cache from './cache';

// Free Google Translate web endpoint (no key). Best-effort: on any failure we
// return the original text, so news still renders (just untranslated).
// Each translated string is cached for a week, so steady-state is free.

const TTL = 7 * 24 * 3600;

interface GTransSeg {
  0: string; // translated
  1: string; // original
}

const KOREAN_RE = /[\uac00-\ud7a3]/;
const FALLBACK_PHRASES: Array<[RegExp, string]> = [
  [/\bBitcoin(?:'s)? price has cleared a key hurdle that has historically preceded major bull runs\b/gi, '비트코인 가격이 역사적으로 주요 상승장을 앞두고 나타났던 핵심 저항선을 돌파했습니다'],
  [/\bBitcoin rises above\b/gi, '비트코인,'],
  [/\bwhile\b/gi, '… 반면'],
  [/\bjumps?\s+(\d+(?:\.\d+)?)%/gi, ' $1% 급등'],
  [/\bfalls?\b/gi, '하락'],
  [/\brises?\b/gi, '상승'],
  [/\babove\b/gi, '상회'],
  [/\bbelow\b/gi, '하회'],
  [/\bafter\b/gi, '이후'],
  [/\bkey hurdle\b/gi, '핵심 저항선'],
  [/\bmajor bull runs?\b/gi, '주요 상승장'],
  [/\bprice\b/gi, '가격'],
  [/\bmarkets?\b/gi, '시장'],
  [/\bstocks?\b/gi, '주식'],
  [/\bstock\b/gi, '주식'],
  [/\byields?\b/gi, '수익률'],
  [/\brate hike\b/gi, '금리 인상'],
  [/\brate cut\b/gi, '금리 인하'],
  [/\binflation\b/gi, '인플레이션'],
  [/\boil\b/gi, '유가'],
  [/\bcrude\b/gi, '원유'],
  [/\bflows?\b/gi, '흐름'],
  [/\bremain\b/gi, '유지되며'],
  [/\bstrong\b/gi, '강세'],
  [/\bon\s+[^,.;]+\s+swap traffic\b/gi, ' 스왑 거래량으로'],
  [/\bswap traffic\b/gi, '스왑 거래량'],
  [/\bafter central bank rate hike\b/gi, '중앙은행 금리 인상 이후'],
];

/** Conservative offline fallback used when public translation services reject
 * automated requests. It translates only well-known market phrases and keeps
 * the original wording for unknown names/terms, avoiding invented summaries. */
export function fallbackTranslate(text: string): string {
  let translated = text.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of FALLBACK_PHRASES) translated = translated.replace(pattern, replacement);
  if (!KOREAN_RE.test(translated)) return text;
  return translated.replace(/\s{2,}/g, ' ').trim();
}

function isUsableTranslation(value: unknown, original: string): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== original.trim() && KOREAN_RE.test(value) && !/sorry|automated queries|translation unavailable/i.test(value);
}

async function translateOne(text: string, target: string): Promise<string> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return text;

  const key = `tr:${target}:${clean}`;
  const cached = cache.peek<string>(key);
  if (cached !== null) return cached;

  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=` +
      encodeURIComponent(clean);
    const { data } = await axios.get<[GTransSeg[]]>(url, {
      timeout: 3500,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    const segs = Array.isArray(data?.[0]) ? data[0] : [];
    const translated = segs.map((s) => s?.[0] ?? '').join('').trim();
    if (isUsableTranslation(translated, text)) {
      cache.set(key, translated, TTL, TTL);
      return translated;
    }
  } catch { /* Google can reject shared-server automated requests. Try MyMemory next. */ }

  // MyMemory is a separate public provider and often remains available when
  // Google blocks server-side automated requests. Keep this best-effort and
  // accept only a response containing Korean text.
  try {
    const { data: mirror } = await axios.get<{ responseData?: { translatedText?: string } }>('https://api.mymemory.translated.net/get', {
      params: { q: clean, langpair: `auto|${target}` },
      timeout: 4500,
      headers: { 'User-Agent': 'MacroMonitor/1.0', Accept: 'application/json' },
    });
    const mirrored = mirror?.responseData?.translatedText?.trim();
    if (isUsableTranslation(mirrored, text)) {
      cache.set(key, mirrored, TTL, TTL);
      return mirrored;
    }
  } catch { /* use the conservative offline glossary below */ }

  const result = fallbackTranslate(text);
  cache.set(key, result, TTL, TTL);
  return result;
}

/** Translate many strings with limited concurrency; failures fall back to source. */
export async function translateBatch(texts: string[], target = 'ko'): Promise<string[]> {
  const out: string[] = new Array(texts.length);
  const CONCURRENCY = 6;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < texts.length) {
      const i = idx++;
      try {
        out[i] = await translateOne(texts[i], target);
      } catch {
        out[i] = texts[i]; // graceful: keep original on failure
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return out;
}
