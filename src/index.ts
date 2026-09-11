import express from 'express';
import cors from 'cors';
import { config, hasFredKey } from './config';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFound } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';
import * as cache from './services/cache';

import fredRouter from './routes/fred';
import yahooRouter from './routes/yahoo';
import coingeckoRouter from './routes/coingecko';
import defillamaRouter from './routes/defillama';
import newsRouter from './routes/news';
import calendarRouter from './routes/calendar';
import marketsRouter from './routes/markets';
import economyRouter from './routes/economy';
import globalRouter from './routes/global';
import onchainRouter from './routes/onchain';
import treasuryRouter from './routes/treasury';
import pushRouter from './routes/push';
import { startAlertCron } from './services/cron';
import personalRouter from './routes/personal';
import { startBriefingCron } from './services/briefingCron';
import { initializePersonalStore } from './services/personalStore';
import morningBriefingRouter from './routes/morningBriefing';

const app = express();

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    // Native Expo clients do not send an Origin header. Browser clients must
    // match the explicit allow-list (or CORS_ORIGIN=* for local development).
    if (!origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin is not allowed: ${origin}`));
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit);
app.use(requestLogger);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    apiVersion: '2026-09-11',
    capabilities: ['quotes.batch', 'markets.morning-briefing', 'personal.briefings', 'personal.events', 'personal.notes'],
    uptime: process.uptime(),
    cacheSize: cache.size(),
    env: config.nodeEnv,
    // Boolean only: lets deployments be verified without ever exposing a key.
    fredConfigured: hasFredKey(),
  });
});

app.use('/api/fred', fredRouter);
app.use('/api/yahoo', yahooRouter);
app.use('/api/coingecko', coingeckoRouter);
app.use('/api/defillama', defillamaRouter);
app.use('/api/news', newsRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/morning-briefing', morningBriefingRouter);
app.use('/api/economy', economyRouter);
app.use('/api/global', globalRouter);
app.use('/api/onchain', onchainRouter);
app.use('/api/treasury', treasuryRouter);
app.use('/api/push', pushRouter);
app.use('/api/personal/v1', personalRouter);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  await initializePersonalStore();
  console.log(`[macromonitor-server] listening on http://localhost:${config.port}`);
  console.log(`[macromonitor-server] env=${config.nodeEnv} corsOrigin=${config.corsOrigin}`);
  startAlertCron();
  startBriefingCron();
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
