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

async function translateOne(text: string, target: string): Promise<string> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return text;

  const key = `tr:${target}:${clean}`;
  const cached = cache.peek<string>(key);
  if (cached !== null) return cached;

  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=` +
    encodeURIComponent(clean);
  const { data } = await axios.get<[GTransSeg[]]>(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });

  const segs = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = segs.map((s) => s?.[0] ?? '').join('').trim();
  const result = translated || text;
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
