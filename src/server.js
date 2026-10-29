import { config, integrationStatus } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { createApp } from './app.js';

setLogLevel(config.logLevel);

process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err });
  process.exit(1);
});

const server = createApp(config).listen(config.port, config.host, () => {
  logger.info('PMO assistant started', {
    url: `http://${config.host}:${config.port}`,
    integrations: integrationStatus(config),
  });
});

server.on('error', (err) => {
  logger.error('server failed to start', { err });
  process.exit(1);
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
