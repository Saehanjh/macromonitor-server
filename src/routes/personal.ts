import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { INTERNAL_HEADER, INTERNAL_SECRET } from '../services/internalAuth';
import * as db from '../services/personalStore';

const router = Router();
function auth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const token = req.header('x-personal-token') || bearer;
  if (config.personalApiToken && token === config.personalApiToken) { (req as any).ownerId = 'default'; return next(); }
  if (config.personalApiAllowLocal && config.nodeEnv !== 'production') {
    const owner = req.header('x-owner-id')?.trim();
    if (owner && /^[A-Za-z0-9_.-]{1,80}$/.test(owner)) { (req as any).ownerId = owner; return next(); }
  }
  return res.status(config.personalApiToken || config.personalApiAllowLocal ? 401 : 503).json({ error: 'personal_api_unavailable', message: config.personalApiToken ? '인증이 필요합니다.' : '개인 API 인증이 구성되지 않았습니다.' });
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
