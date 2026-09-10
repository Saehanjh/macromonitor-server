import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { isSupabaseConfigured, readStore, writeStore } from './supabaseAdapter';

export type VerificationStatus = 'verified' | 'unverified' | 'unavailable';
export type CoverageStatus = 'complete' | 'partial' | 'failed';

export interface Instrument { id: string; ticker: string; exchange: string; currency: string; name: string; providerSymbol: string; cik?: string; verificationStatus: VerificationStatus; }
export interface QuoteSnapshot { instrumentId: string; price: number | null; previousClose: number | null; currency: string; asOf: string | null; fetchedAt: string; source: string; status: 'ok' | 'missing' | 'error'; }
export interface Evidence { id: string; instrumentId: string; kind: 'news' | 'filing'; url?: string; title: string; publishedAt?: string; fetchedAt: string; accessionNumber?: string; contentHash?: string; }
export interface Snapshot { id: string; runId: string; createdAt: string; coverage: { status: CoverageStatus; requested: number; succeeded: number; failed: number; sources: Record<string, CoverageStatus> }; quotes: QuoteSnapshot[]; evidence: Evidence[]; }
export interface WatchlistEntry { ownerId: string; instrumentId: string; createdAt: string; }
export interface Holding { ownerId: string; instrumentId: string; quantity: number; averageCost: number; updatedAt: string; }
export type PipelineStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export interface Delivery { id: string; briefingId: string; channel: 'telegram' | 'app'; recipientId: string; status: PipelineStatus; attempts: number; createdAt: string; updatedAt: string; deliveredAt?: string; error?: string; }
export interface BriefingJob { id: string; runId: string; ownerId: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; collectionStatus: PipelineStatus; generationStatus: PipelineStatus; deliveryStatus: PipelineStatus; createdAt: string; updatedAt: string; snapshotId?: string; error?: string; deliveries?: Delivery[]; }
export type TrackerStatus = 'active' | 'paused';
export interface Tracker { id: string; ownerId: string; instrumentId: string; label: string; keywords: string[]; status: TrackerStatus; createdAt: string; updatedAt: string; lastCheckedAt?: string; knownEvidenceKeys: string[]; }
export type EventReview = 'unreviewed' | 'confirmed' | 'monitoring';
export type EventClassification = 'new_evidence' | 'known_evidence' | 'collection_failure' | 'parse_failure';
export interface EventMatch { id: string; ownerId: string; trackerId: string; instrumentId: string; evidenceId?: string; evidenceKey?: string; classification: EventClassification; title: string; detail?: string; detectedAt: string; review: EventReview; }
export interface InvestmentNote { id: string; ownerId: string; instrumentId: string; thesis: string; risk: string; reviewCondition?: string; evidenceIds: string[]; createdAt: string; updatedAt: string; }
interface Store { instruments: Instrument[]; watchlist: WatchlistEntry[]; holdings: Holding[]; snapshots: Snapshot[]; jobs: BriefingJob[]; deliveries: Delivery[]; trackers: Tracker[]; events: EventMatch[]; notes: InvestmentNote[]; }

const empty: Store = { instruments: [], watchlist: [], holdings: [], snapshots: [], jobs: [], deliveries: [], trackers: [], events: [], notes: [] };
function ensureDir(file: string) { const dir = path.dirname(file); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function read(): Store { try { if (fs.existsSync(config.personalStorePath)) return { ...empty, ...JSON.parse(fs.readFileSync(config.personalStorePath, 'utf8')) }; } catch { /* recover with empty store */ } return { ...empty }; }
let store = read();
function persist() { ensureDir(config.personalStorePath); const tmp = `${config.personalStorePath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8'); fs.renameSync(tmp, config.personalStorePath); if (isSupabaseConfigured()) void writeStore(config.briefing.ownerId, store).catch((error) => console.error('[personal-store] Supabase mirror failed:', error.message)); }
export async function initializePersonalStore(): Promise<void> { if (!isSupabaseConfigured()) return; try { const remote = await readStore<Store>(config.briefing.ownerId); if (remote) { store = { ...empty, ...remote }; persistLocalOnly(); } } catch (error) { console.error('[personal-store] Supabase unavailable; using local JSON fallback:', (error as Error).message); } }
function persistLocalOnly() { ensureDir(config.personalStorePath); const tmp = `${config.personalStorePath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8'); fs.renameSync(tmp, config.personalStorePath); }
export function normalizeTicker(value: string): string { return value.trim().toUpperCase(); }
export function validatePositiveFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
export function instrumentId(exchange: string, ticker: string) { return `${exchange.toUpperCase()}:${normalizeTicker(ticker)}`; }
export function ownerState(ownerId: string) { return { watchlist: store.watchlist.filter(x => x.ownerId === ownerId), holdings: store.holdings.filter(x => x.ownerId === ownerId) }; }
export function upsertInstrument(input: Partial<Instrument> & { ticker: string }): Instrument { const exchange = (input.exchange || 'US').toUpperCase(); const ticker = normalizeTicker(input.ticker); const id = input.id || instrumentId(exchange, ticker); const found = store.instruments.find(x => x.id === id); const item: Instrument = { id, ticker, exchange, currency: input.currency || (exchange === 'KR' ? 'KRW' : 'USD'), name: input.name || ticker, providerSymbol: input.providerSymbol || ticker, cik: input.cik || undefined, verificationStatus: input.verificationStatus || 'unverified' }; if (found) Object.assign(found, item); else store.instruments.push(item); persist(); return item; }
export function findInstruments(q: string) { const query = normalizeTicker(q); return store.instruments.filter(x => x.ticker.includes(query) || x.name.toUpperCase().includes(query)).slice(0, 25); }
export function addWatchlist(ownerId: string, instrument: Instrument) { if (!store.watchlist.some(x => x.ownerId === ownerId && x.instrumentId === instrument.id)) { store.watchlist.push({ ownerId, instrumentId: instrument.id, createdAt: new Date().toISOString() }); persist(); } return ownerState(ownerId).watchlist; }
export function removeWatchlist(ownerId: string, instrumentIdValue: string) { store.watchlist = store.watchlist.filter(x => !(x.ownerId === ownerId && x.instrumentId === instrumentIdValue)); persist(); return ownerState(ownerId).watchlist; }
export function saveHolding(ownerId: string, instrumentIdValue: string, quantity: number, averageCost: number) { if (!validatePositiveFinite(quantity) || !validatePositiveFinite(averageCost)) throw new Error('quantity and averageCost must be finite positive numbers'); const existing = store.holdings.find(x => x.ownerId === ownerId && x.instrumentId === instrumentIdValue); const item = { ownerId, instrumentId: instrumentIdValue, quantity, averageCost, updatedAt: new Date().toISOString() }; if (existing) Object.assign(existing, item); else store.holdings.push(item); persist(); return item; }
export function deleteHolding(ownerId: string, instrumentIdValue: string) { store.holdings = store.holdings.filter(x => !(x.ownerId === ownerId && x.instrumentId === instrumentIdValue)); persist(); }
export function evidenceKey(e: Evidence): string { if (e.url?.trim()) return `url:${e.url.trim()}`; if (e.accessionNumber?.trim()) return `accession:${e.accessionNumber.trim()}`; if (e.contentHash?.trim()) return `hash:${e.contentHash.trim().toLowerCase()}`; return `id:${e.id}`; }
export function classifyEvidence(key: string, previousKeys: Set<string>, knownKeys: string[]): EventClassification { return previousKeys.has(key) || knownKeys.includes(key) ? 'known_evidence' : 'new_evidence'; }
function ownedInstrumentIds(ownerId: string) { const state = ownerState(ownerId); return new Set(state.holdings.concat(state.watchlist as any).map((x: any) => x.instrumentId)); }
function matchEvents(snapshot: Snapshot) {
  const owners = new Set([...store.watchlist.map(x => x.ownerId), ...store.holdings.map(x => x.ownerId), ...store.trackers.map(x => x.ownerId)]);
  const previousKeys = new Set(store.snapshots.flatMap(s => s.evidence.map(evidenceKey)));
  for (const ownerId of owners) {
    const trackers = store.trackers.filter(t => t.ownerId === ownerId && t.status === 'active' && ownedInstrumentIds(ownerId).has(t.instrumentId));
    for (const tracker of trackers) {
      const relevant = snapshot.evidence.filter(e => e.instrumentId === tracker.instrumentId && (tracker.keywords.length === 0 || tracker.keywords.some(k => `${e.title}`.toLocaleLowerCase().includes(k.toLocaleLowerCase()))));
      for (const evidence of relevant) {
        const key = evidenceKey(evidence);
        if (store.events.some(x => x.ownerId === ownerId && x.trackerId === tracker.id && x.evidenceKey === key)) continue;
        const now = new Date().toISOString();
        store.events.push({ id: crypto.randomUUID(), ownerId, trackerId: tracker.id, instrumentId: tracker.instrumentId, evidenceId: evidence.id, evidenceKey: key, classification: classifyEvidence(key, previousKeys, tracker.knownEvidenceKeys), title: evidence.title, detail: evidence.url || evidence.accessionNumber, detectedAt: now, review: 'unreviewed' });
        if (!tracker.knownEvidenceKeys.includes(key)) tracker.knownEvidenceKeys.push(key);
      }
      tracker.lastCheckedAt = snapshot.createdAt;
      tracker.updatedAt = new Date().toISOString();
      if (snapshot.coverage.status !== 'complete') store.events.push({ id: crypto.randomUUID(), ownerId, trackerId: tracker.id, instrumentId: tracker.instrumentId, classification: 'collection_failure', title: '이벤트 수집 범위가 완전하지 않습니다.', detail: `${snapshot.coverage.status} · ${snapshot.coverage.failed}건 실패`, detectedAt: new Date().toISOString(), review: 'unreviewed' });
    }
  }
}
export function saveSnapshot(snapshot: Snapshot) { const existing = store.snapshots.find(x => x.runId === snapshot.runId); if (existing) { Object.assign(existing, snapshot); } else { matchEvents(snapshot); store.snapshots.push(snapshot); } store.snapshots = store.snapshots.slice(-100); persist(); return snapshot; }
export function latestSnapshot(ownerId: string): Snapshot | null { const owned = new Set(ownerState(ownerId).holdings.concat(ownerState(ownerId).watchlist as any).map((x: any) => x.instrumentId)); return [...store.snapshots].reverse().find(s => s.quotes.some(q => owned.has(q.instrumentId))) || null; }
export function listBriefings(ownerId: string) { return store.snapshots.filter(s => latestSnapshot(ownerId)?.id === s.id).map(s => ({ id: s.id, runId: s.runId, createdAt: s.createdAt, coverage: s.coverage })); }
function ownsSnapshot(ownerId: string, snapshot: Snapshot) {
  const state = ownerState(ownerId);
  const owned = new Set(state.holdings.concat(state.watchlist as any).map((x: any) => x.instrumentId));
  return snapshot.quotes.some(q => owned.has(q.instrumentId)) || snapshot.evidence.some(e => owned.has(e.instrumentId));
}
export function listBriefingsForOwner(ownerId: string) { return store.snapshots.filter(s => ownsSnapshot(ownerId, s)).slice(-30).reverse().map(s => ({ id: s.id, runId: s.runId, createdAt: s.createdAt, coverage: s.coverage, evidenceCount: s.evidence.length })); }
export function getBriefing(ownerId: string, id: string) { const snapshot = store.snapshots.find(s => s.id === id && ownsSnapshot(ownerId, s)); return snapshot || null; }
export function createJob(ownerId: string, idempotencyKey: string): BriefingJob { const runId = crypto.createHash('sha256').update(`${ownerId}:${idempotencyKey}`).digest('hex').slice(0, 24); const existing = store.jobs.find(x => x.runId === runId); if (existing) return existing; const now = new Date().toISOString(); const job: BriefingJob = { id: crypto.randomUUID(), runId, ownerId, status: 'queued', collectionStatus: 'pending', generationStatus: 'pending', deliveryStatus: 'pending', createdAt: now, updatedAt: now, deliveries: [] }; store.jobs.push(job); persist(); return job; }
export function getJob(ownerId: string, id: string) { return store.jobs.find(x => x.ownerId === ownerId && (x.id === id || x.runId === id)) || null; }
export function updateJob(runId: string, patch: Partial<Pick<BriefingJob, 'status'|'collectionStatus'|'generationStatus'|'deliveryStatus'|'snapshotId'|'error'>>) { const job = store.jobs.find(x => x.runId === runId); if (!job) return null; Object.assign(job, patch, { updatedAt: new Date().toISOString() }); persist(); return job; }
export function createDelivery(briefingId: string, channel: Delivery['channel'], recipientId: string): Delivery { const existing = store.deliveries.find(d => d.briefingId === briefingId && d.channel === channel && d.recipientId === recipientId); if (existing) return existing; const now = new Date().toISOString(); const item: Delivery = { id: crypto.randomUUID(), briefingId, channel, recipientId, status: 'pending', attempts: 0, createdAt: now, updatedAt: now }; store.deliveries.push(item); persist(); return item; }
export function updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status'|'attempts'|'deliveredAt'|'error'>>) { const d = store.deliveries.find(x => x.id === id); if (!d) return null; Object.assign(d, patch, { updatedAt: new Date().toISOString() }); persist(); return d; }
export function listDeliveries(ownerId: string, briefingId?: string) { const ids = new Set(store.jobs.filter(j => j.ownerId === ownerId && (!briefingId || j.id === briefingId || j.runId === briefingId)).map(j => j.runId)); return store.deliveries.filter(d => ids.has(d.briefingId)); }
export function getInstrument(id: string) { return store.instruments.find(x => x.id === id); }
export function listTrackers(ownerId: string) { return store.trackers.filter(x => x.ownerId === ownerId); }
export function saveTracker(ownerId: string, input: { id?: string; instrumentId: string; label: string; keywords?: string[]; status?: TrackerStatus }) { if (!getInstrument(input.instrumentId) || !ownedInstrumentIds(ownerId).has(input.instrumentId)) throw new Error('보유 또는 관심종목만 추적할 수 있습니다.'); if (!input.label?.trim() || input.label.length > 120) throw new Error('추적 이름을 확인해 주세요.'); const now = new Date().toISOString(); const current = input.id ? store.trackers.find(x => x.id === input.id && x.ownerId === ownerId) : undefined; if (input.id && !current) throw new Error('추적 규칙을 찾을 수 없습니다.'); const item = current || { id: crypto.randomUUID(), ownerId, instrumentId: input.instrumentId, label: input.label.trim(), keywords: [], status: 'active' as const, createdAt: now, updatedAt: now, knownEvidenceKeys: [] }; Object.assign(item, { instrumentId: input.instrumentId, label: input.label.trim(), keywords: (input.keywords || []).map(k => k.trim()).filter(Boolean).slice(0, 20), status: input.status || item.status, updatedAt: now }); if (!current) store.trackers.push(item); persist(); return item; }
export function deleteTracker(ownerId: string, id: string) { store.trackers = store.trackers.filter(x => !(x.ownerId === ownerId && x.id === id)); persist(); }
export function listEvents(ownerId: string) { return store.events.filter(x => x.ownerId === ownerId).slice(-100).reverse(); }
export function reviewEvent(ownerId: string, id: string, review: EventReview) { const e = store.events.find(x => x.ownerId === ownerId && x.id === id); if (!e) return null; e.review = review; persist(); return e; }
export function listNotes(ownerId: string) { return store.notes.filter(x => x.ownerId === ownerId).slice(-100).reverse(); }
export function saveNote(ownerId: string, input: Omit<InvestmentNote, 'id'|'ownerId'|'createdAt'|'updatedAt'> & { id?: string }) { if (!getInstrument(input.instrumentId) || !ownedInstrumentIds(ownerId).has(input.instrumentId)) throw new Error('보유 또는 관심종목만 노트에 연결할 수 있습니다.'); if (!input.thesis?.trim() || !input.risk?.trim()) throw new Error('투자 근거와 위험을 입력해 주세요.'); const now = new Date().toISOString(); const current = input.id ? store.notes.find(x => x.id === input.id && x.ownerId === ownerId) : undefined; if (input.id && !current) throw new Error('투자노트를 찾을 수 없습니다.'); const item = current || { id: crypto.randomUUID(), ownerId, instrumentId: input.instrumentId, thesis: '', risk: '', evidenceIds: [], createdAt: now, updatedAt: now }; Object.assign(item, { instrumentId: input.instrumentId, thesis: input.thesis.trim(), risk: input.risk.trim(), reviewCondition: input.reviewCondition?.trim() || undefined, evidenceIds: (input.evidenceIds || []).filter(id => store.snapshots.some(s => s.evidence.some(e => e.id === id))), updatedAt: now }); if (!current) store.notes.push(item); persist(); return item; }
export function deleteNote(ownerId: string, id: string) { store.notes = store.notes.filter(x => !(x.ownerId === ownerId && x.id === id)); persist(); }
export function validateSnapshotInput(value: unknown): value is Snapshot { const s = value as Partial<Snapshot> | null; if (!s || typeof s.runId !== 'string' || !Array.isArray(s.quotes) || !Array.isArray(s.evidence) || !s.coverage || !['complete', 'partial', 'failed'].includes(s.coverage.status as string)) return false; return s.evidence.every(e => !!e && typeof e.id === 'string' && typeof e.instrumentId === 'string' && (e.kind === 'news' || e.kind === 'filing') && typeof e.title === 'string' && e.title.trim().length > 0 && typeof e.fetchedAt === 'string'); }
