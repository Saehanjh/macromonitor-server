import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config';
import { INTERNAL_HEADER, INTERNAL_SECRET } from '../services/internalAuth';
import * as db from '../services/personalStore';

const router = Router();
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365;

function sessionSecret(): string {
  return config.personalSessionSecret || config.personalApiToken;
}

function signSession(ownerId: string): string {
  const payload = Buffer.from(`${ownerId}.${Math.floor(Date.now() / 1000)}`, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function sessionOwner(token: string): string | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !sessionSecret()) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const [ownerId, issuedAt] = Buffer.from(payload, 'base64url').toString('utf8').split('.');
    const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
    if (!ownerId || !/^[a-f0-9]{64}$/.test(ownerId) || !Number.isFinite(age) || age < 0 || age > SESSION_TTL_SECONDS) return null;
    return ownerId;
  } catch { return null; }
}

function deviceOwner(deviceId: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(`device:${deviceId}`).digest('hex');
}

// Public bootstrap endpoint. It creates a stable owner id from a random
// per-install device id; the returned bearer token is unique to that install.
router.post('/session', (req, res) => {
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  if (!sessionSecret()) return res.status(503).json({ error: 'personal_session_unavailable', message: '서버에 개인 세션 비밀값이 설정되지 않았습니다. Render 환경변수 PERSONAL_SESSION_SECRET를 설정해 주세요.' });
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(deviceId)) return bad(res, '기기 식별자가 필요합니다. 앱을 최신 버전으로 다시 설치해 주세요.');
  const ownerId = deviceOwner(deviceId);
  return res.status(201).json({ ownerId, token: signSession(ownerId), expiresIn: SESSION_TTL_SECONDS });
});

function auth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const token = req.header('x-personal-token') || bearer;
  if (config.personalApiToken && token === config.personalApiToken) { (req as any).ownerId = 'default'; return next(); }
  const ownerId = token ? sessionOwner(token) : null;
  if (ownerId) { (req as any).ownerId = ownerId; return next(); }
  if (config.personalApiAllowLocal && config.nodeEnv !== 'production') {
    const owner = req.header('x-owner-id')?.trim();
    if (owner && /^[A-Za-z0-9_.-]{1,80}$/.test(owner)) { (req as any).ownerId = owner; return next(); }
  }
  return res.status(config.personalApiToken || config.personalSessionSecret || config.personalApiAllowLocal ? 401 : 503).json({ error: 'personal_api_unavailable', message: config.personalApiToken || config.personalSessionSecret ? '개인 API 인증이 필요합니다.' : '서버에 개인 세션 비밀값이 설정되지 않았습니다. Render 환경변수 PERSONAL_SESSION_SECRET를 설정해 주세요.' });
}
function owner(req: Request) { return (req as any).ownerId as string; }
function bad(res: Response, message: string) { return res.status(400).json({ error: 'invalid_request', message }); }

router.use(auth);
router.get('/instruments/search', (req, res) => { const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''; if (q.length < 1 || q.length > 40) return bad(res, 'q는 1~40자여야 합니다.'); return res.json({ items: db.findInstruments(q), query: q }); });
router.post('/instruments', (req, res) => { if (typeof req.body?.ticker !== 'string') return bad(res, 'ticker가 필요합니다.'); return res.status(201).json(db.upsertInstrument(req.body)); });
router.get('/watchlist', (req, res) => res.json({ items: db.ownerState(owner(req)).watchlist }));
router.post('/watchlist', (req, res) => { if (typeof req.body?.instrumentId !== 'string') return bad(res, 'instrumentId가 필요합니다.'); const i = db.getInstrument(req.body.instrumentId); if (!i) return res.status(404).json({ error: 'instrument_not_found', message: '종목을 먼저 등록하세요.' }); return res.status(201).json({ items: db.addWatchlist(owner(req), i) }); });
router.delete('/watchlist/:instrumentId', (req, res) => res.json({ items: db.removeWatchlist(owner(req), req.params.instrumentId) }));
router.get('/holdings', (req, res) => res.json({ items: db.ownerState(owner(req)).holdings }));
router.post('/holdings', (req, res) => { const { instrumentId, quantity, averageCost } = req.body || {}; if (typeof instrumentId !== 'string' || !db.getInstrument(instrumentId)) return bad(res, '유효한 instrumentId가 필요합니다.'); try { return res.status(201).json(db.saveHolding(owner(req), instrumentId, quantity, averageCost)); } catch (e) { return bad(res, (e as Error).message); } });
router.delete('/holdings/:instrumentId', (req, res) => { db.deleteHolding(owner(req), req.params.instrumentId); return res.status(204).send(); });
router.get('/snapshots/latest', (req, res) => { const value = db.latestSnapshot(owner(req)); if (!value) return res.status(404).json({ error: 'snapshot_not_found', message: '저장된 스냅샷이 없습니다.' }); return res.json(value); });
router.get('/briefings', (req, res) => res.json({ items: db.listBriefingsForOwner(owner(req)) }));
router.get('/briefings/:id', (req, res) => { const briefing = db.getBriefing(owner(req), req.params.id); return briefing ? res.json(briefing) : res.status(404).json({ error: 'briefing_not_found', message: '저장된 브리핑을 찾을 수 없습니다.' }); });
router.post('/briefing-jobs', (req, res) => { const key = req.header('idempotency-key') || req.body?.idempotencyKey; if (typeof key !== 'string' || key.length < 8 || key.length > 200) return bad(res, 'Idempotency-Key가 필요합니다(8~200자).'); const job = db.createJob(owner(req), key); return res.status(202).json(job); });
router.get('/briefing-jobs/:id', (req, res) => { const job = db.getJob(owner(req), req.params.id); return job ? res.json(job) : res.status(404).json({ error: 'job_not_found', message: '작업을 찾을 수 없습니다.' }); });
router.get('/briefing-jobs/:id/deliveries', (req, res) => res.json({ items: db.listDeliveries(owner(req), req.params.id) }));
router.get('/trackers', (req, res) => res.json({ items: db.listTrackers(owner(req)) }));
router.post('/trackers', (req, res) => { const { instrumentId, label, keywords, status } = req.body || {}; try { return res.status(201).json(db.saveTracker(owner(req), { instrumentId, label, keywords, status })); } catch (e) { return bad(res, (e as Error).message); } });
router.patch('/trackers/:id', (req, res) => { try { const item = db.saveTracker(owner(req), { ...req.body, id: req.params.id }); return res.json(item); } catch (e) { return bad(res, (e as Error).message); } });
router.delete('/trackers/:id', (req, res) => { db.deleteTracker(owner(req), req.params.id); return res.status(204).send(); });
router.get('/events', (req, res) => res.json({ items: db.listEvents(owner(req)) }));
router.patch('/events/:id/review', (req, res) => { const review = req.body?.review; if (!['unreviewed', 'confirmed', 'monitoring'].includes(review)) return bad(res, 'review가 올바르지 않습니다.'); const item = db.reviewEvent(owner(req), req.params.id, review); return item ? res.json(item) : res.status(404).json({ error: 'event_not_found', message: '이벤트를 찾을 수 없습니다.' }); });
router.get('/notes', (req, res) => res.json({ items: db.listNotes(owner(req)) }));
router.post('/notes', (req, res) => { try { return res.status(201).json(db.saveNote(owner(req), req.body || {})); } catch (e) { return bad(res, (e as Error).message); } });
router.patch('/notes/:id', (req, res) => { try { return res.json(db.saveNote(owner(req), { ...req.body, id: req.params.id })); } catch (e) { return bad(res, (e as Error).message); } });
router.delete('/notes/:id', (req, res) => { db.deleteNote(owner(req), req.params.id); return res.status(204).send(); });

// Python worker only: internal secret is per-process and never shipped to mobile.
router.post('/snapshots', (req, res) => { if (req.header(INTERNAL_HEADER) !== INTERNAL_SECRET) return res.status(401).json({ error: 'internal_only', message: '작업자 전용 엔드포인트입니다.' }); const s = req.body; if (!db.validateSnapshotInput(s)) return bad(res, 'runId, quotes, coverage와 유효한 evidence가 필요합니다.'); return res.status(201).json(db.saveSnapshot({ ...s, id: s.id || cryptoId(s.runId), createdAt: s.createdAt || new Date().toISOString() })); });
router.patch('/briefing-jobs/:id/status', (req, res) => { if (req.header(INTERNAL_HEADER) !== INTERNAL_SECRET) return res.status(401).json({ error: 'internal_only' }); const job = db.getJob('default', req.params.id); if (!job) return res.status(404).json({ error: 'job_not_found' }); const updated = db.updateJob(job.runId, req.body || {}); return res.json(updated); });
router.post('/briefing-deliveries', (req, res) => { if (req.header(INTERNAL_HEADER) !== INTERNAL_SECRET) return res.status(401).json({ error: 'internal_only' }); const { briefingId, channel, recipientId } = req.body || {}; if (typeof briefingId !== 'string' || !['telegram', 'app'].includes(channel) || typeof recipientId !== 'string') return bad(res, 'briefingId, channel, recipientId가 필요합니다.'); return res.status(201).json(db.createDelivery(briefingId, channel, recipientId)); });
router.patch('/briefing-deliveries/:id', (req, res) => { if (req.header(INTERNAL_HEADER) !== INTERNAL_SECRET) return res.status(401).json({ error: 'internal_only' }); const updated = db.updateDelivery(req.params.id, req.body || {}); return updated ? res.json(updated) : res.status(404).json({ error: 'delivery_not_found' }); });
function cryptoId(runId: string) { return `snapshot_${Buffer.from(runId).toString('base64url').slice(0, 32)}`; }
export default router;
