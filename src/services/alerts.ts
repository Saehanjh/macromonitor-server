import axios from 'axios';
import { config } from '../config';
import { INTERNAL_SECRET, INTERNAL_HEADER } from './internalAuth';

// Evaluates alert triggers by reading this server's own API (which already has
// dummy fallback). Each evaluator returns whether the alert condition is
// currently ACTIVE. The cron layer turns active-edges into push sends.

export interface AlertDef {
  id: string;
  title: string;
  body: (ctx: number | string) => string;
}

export interface AlertResult {
  id: string;
  active: boolean;
  title: string;
  body: string;
}

type Pt = { t: number; v: number };

const api = axios.create({
  baseURL: config.push.selfBaseUrl,
  timeout: 12_000,
  headers: { [INTERNAL_HEADER]: INTERNAL_SECRET }, // bypass own rate limiter
});

async function get<T>(path: string): Promise<T> {
  const { data } = await api.get<T>(path);
  return data;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
// rolling 5-sample stdev series (mirrors frontend rollingStd)
function rollingStd(points: Pt[], window: number): Pt[] {
  const out: Pt[] = [];
  for (let i = window - 1; i < points.length; i++) {
    out.push({ t: points[i].t, v: std(points.slice(i - window + 1, i + 1).map((p) => p.v)) });
  }
  return out;
}
const lastV = (pts: Pt[]): number | null => (pts.length ? pts[pts.length - 1].v : null);
function changeOverN(pts: Pt[], n: number): number | null {
  if (pts.length <= n) return null;
  return pts[pts.length - 1].v - pts[pts.length - 1 - n].v;
}

// ── individual evaluators ──────────────────────────────────────────────

// 1) VIX ≥ 30
async function evalVix(): Promise<{ active: boolean; value: number }> {
  const d = await get<{ vix: { value: number } }>('/api/markets/volatility');
  const v = d.vix?.value ?? 0;
  return { active: v >= 30, value: v };
}

// 2) BTC ETF — 3 consecutive daily net outflows
async function evalBtcEtf(): Promise<{ active: boolean; days: number }> {
  const d = await get<{ daily: Pt[] }>('/api/onchain/btc-etf');
  const daily = d.daily ?? [];
  let days = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].v < 0) days++;
    else break;
  }
  return { active: days >= 3, days };
}

// 3) Sahm rule ≥ 0.50
async function evalSahm(): Promise<{ active: boolean; value: number }> {
  const d = await get<{ stages: Array<{ key: string; points: Pt[] }> }>('/api/economy/labor');
  const sahm = d.stages?.find((s) => s.key === 'sahm');
  const v = sahm ? lastV(sahm.points) ?? 0 : 0;
  return { active: v >= 0.5, value: Number(v.toFixed(2)) };
}

// 4) Repo "reverse_alert": ΔRRP(5) > 0 AND ΔSOFRvol(5) > 0
async function evalRepo(): Promise<{ active: boolean }> {
  const d = await get<{ rrp: { points: Pt[] }; sofr: { points: Pt[] } }>('/api/markets/repo-phase');
  const dRRP = changeOverN(d.rrp?.points ?? [], 5);
  const volSeries = rollingStd(d.sofr?.points ?? [], 5);
  const dVol = changeOverN(volSeries, 5);
  const active = dRRP != null && dVol != null && dRRP > 0 && dVol > 0;
  return { active };
}

// 5) Consumer fake-boom: sentiment ok + savings danger + delinquency danger
async function evalFakeBoom(): Promise<{ active: boolean }> {
  const d = await get<{
    sentiment: { points: Pt[] };
    savings: { points: Pt[] };
    delinquency: { points: Pt[] };
  }>('/api/economy/consumer');
  const sent = lastV(d.sentiment?.points ?? []);
  const save = lastV(d.savings?.points ?? []);
  const delq = lastV(d.delinquency?.points ?? []);
  const sentOk = sent != null && sent >= 75;
  const saveDanger = save != null && save < 3.5;
  const delqDanger = delq != null && delq >= 3.5;
  return { active: sentOk && saveDanger && delqDanger };
}

// ── evaluate all → AlertResult[] ───────────────────────────────────────
export async function evaluateAll(): Promise<AlertResult[]> {
  const results: AlertResult[] = [];

  const run = async (
    id: string,
    title: string,
    fn: () => Promise<{ active: boolean } & Record<string, unknown>>,
    body: (ctx: Record<string, unknown>) => string,
  ) => {
    try {
      const r = await fn();
      results.push({ id, title, active: r.active, body: body(r) });
    } catch (err) {
      // evaluator failed (upstream outage) — SKIP this alert entirely so the
      // stored edge-state is preserved; marking it inactive here would cause a
      // duplicate re-fire once the outage recovers.
      console.warn(`[alerts] evaluator "${id}" failed:`, (err as Error).message);
    }
  };

  await Promise.all([
    run('vix30', '⚠️ VIX 30 돌파', evalVix, (c) => `변동성 급등 — VIX ${(c.value as number).toFixed(1)}. 리스크오프 국면 경계.`),
    run('btc_etf_outflow', '🩸 BTC ETF 연속 순유출', evalBtcEtf, (c) => `${c.days as number}일 연속 순유출 — 기관 매수세 둔화 시그널.`),
    run('sahm', '🚨 샴룰 발동', evalSahm, (c) => `샴룰 지표 ${(c.value as number).toFixed(2)} — 침체 신호 임계 도달.`),
    run('repo_reverse', '🔁 레포 역류경보', evalRepo, () => 'ON RRP↑ & SOFR 변동성↑ — 민간 레포 압박 가능성.'),
    run('fake_boom', '🎭 가짜 호황 경고', evalFakeBoom, () => '소비심리는 양호하나 저축률·연체율 동반 악화 — 다이버전스.'),
  ]);

  return results;
}
