import cron from 'node-cron';
import { config } from '../config';
import { createJob } from './personalStore';

// Scheduling only enqueues an idempotent job. Collection, generation and delivery
// are performed by the Python worker, so a delayed/restarted server cannot send twice.
export function startBriefingCron(): void {
  if (!config.briefing.enabled) { console.log('[briefing] scheduler disabled (BRIEFING_ENABLED=false)'); return; }
  if (!cron.validate(config.briefing.cron)) { console.warn(`[briefing] invalid BRIEFING_CRON "${config.briefing.cron}"`); return; }
  cron.schedule(config.briefing.cron, () => {
    const day = new Date().toISOString().slice(0, 10);
    const job = createJob(config.briefing.ownerId, `scheduled:${day}`);
    console.log(`[briefing] queued ${job.runId} (${day}); worker must process it`);
  }, { timezone: 'Asia/Seoul' });
  console.log(`[briefing] scheduler started (${config.briefing.cron}, Asia/Seoul)`);
}
