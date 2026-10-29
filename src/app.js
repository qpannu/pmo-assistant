import express from 'express';
import { integrationStatus } from './config.js';
import { logger } from './logger.js';

export function createApp(config) {
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
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      integrations: integrationStatus(config),
    });
  });

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
