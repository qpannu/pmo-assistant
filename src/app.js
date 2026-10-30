import express from 'express';
import { integrationStatus } from './config.js';
import { logger } from './logger.js';
import { sourceRoutes } from './routes/sources.js';
import { actionRoutes } from './routes/actions.js';
import { priorityRoutes } from './routes/priorities.js';
import { assistantRoutes } from './routes/assistant.js';
import { reportRoutes } from './routes/reports.js';
import { jiraOverview } from './jira/sync.js';
import { outlookOverview } from './outlook/sync.js';
import { teamsOverview } from './teams/sync.js';

export function createApp(config, { db, store, scheduler, reasoner = null, notifier = null, claude = null, briefings = null, jiraClient = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.debug('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  app.get('/health', (req, res) => {
    let dbOk;
    if (db) {
      try {
        dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1;
      } catch (err) {
        logger.error('db health check failed', { err });
        dbOk = false;
      }
    }
    res.status(dbOk === false ? 503 : 200).json({
      status: dbOk === false ? 'degraded' : 'ok',
      uptimeSec: Math.round(process.uptime()),
      db: dbOk,
      integrations: integrationStatus(config),
    });
  });

  if (store && scheduler) {
    app.use('/jira', sourceRoutes({
      task: 'jira', scheduler, overview: () => jiraOverview(store),
      setupHint: 'Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env.',
    }));
    app.use('/outlook', sourceRoutes({
      task: 'outlook', scheduler, overview: () => outlookOverview(store),
      setupHint: 'Set MS_TENANT_ID and MS_CLIENT_ID in .env, run `npm run ms:login`, then restart.',
    }));
    app.use('/teams', sourceRoutes({
      task: 'teams', scheduler, overview: () => teamsOverview(store),
      setupHint: 'Set MS_TENANT_ID and MS_CLIENT_ID in .env, run `npm run ms:login`, then restart.',
    }));
    app.use('/actions', actionRoutes({ store }));
    app.use('/reports', reportRoutes({ store, config, jiraClient, claude }));
    app.use('/', priorityRoutes({ store, reasoner }));
    if (notifier && claude && briefings) {
      app.use('/', assistantRoutes({ store, config, scheduler, notifier, claude, briefings }));
    }
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Express 5 forwards rejected async handlers here too.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    logger.error('request failed', { method: req.method, path: req.path, status, err });
    if (res.headersSent) return next(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}
