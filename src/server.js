import { config, integrationStatus } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createScheduler } from './scheduler.js';
import { createJiraClient } from './jira/client.js';
import { syncJira } from './jira/sync.js';

setLogLevel(config.logLevel);

const db = openDb(config.dbPath);
logger.info('db opened', { path: config.dbPath });
const store = createStore(db);
const scheduler = createScheduler();
const integrations = integrationStatus(config);

if (integrations.jira) {
  const client = createJiraClient(config.jira);
  scheduler.every('jira', config.syncMinutes.jira, () => syncJira({ client, store, jira: config.jira }));
  if (!config.jira.projects.length) {
    logger.warn('JIRA_PROJECTS is empty: production bugs and releases are not tracked, only issues involving you');
  }
} else {
  logger.info('jira not configured; skipping (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
}

process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err });
  process.exit(1);
});

// Express 5 also calls this callback when listening fails; 'error' below handles that.
const server = createApp(config, { db, store, scheduler }).listen(config.port, config.host, (err) => {
  if (err) return;
  logger.info('PMO assistant started', { url: `http://${config.host}:${config.port}`, integrations });
});

server.on('error', (err) => {
  const hint = err.code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use, probably by another PMO assistant. Stop it (Ctrl+C in its terminal) or set PORT in .env.`
    : undefined;
  logger.error('server failed to start', { err, hint });
  process.exit(1);
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
