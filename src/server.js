import { config, integrationStatus, msScopes } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createScheduler } from './scheduler.js';
import { createJiraClient } from './jira/client.js';
import { syncJira } from './jira/sync.js';
import { createMsAuth } from './microsoft/auth.js';
import { createGraphClient } from './microsoft/graph.js';
import { syncOutlook } from './outlook/sync.js';
import { syncTeams } from './teams/sync.js';
import { syncActions } from './actions.js';
import { runPriorityEngine } from './priority/engine.js';
import { createClaudeReasoner } from './priority/reason.js';
import { readFileSync } from 'node:fs';
import { createClaude } from './claude/client.js';
import { createTeamsNotifier, notifyPendingAlerts } from './notify/teams.js';
import { createBriefingService } from './briefing/briefing.js';
import { startBriefingSchedule } from './briefing/schedule.js';
import { checkAndAlert } from './monitor.js';
import { createChatHandler } from './chat/handler.js';
import { createChatListener } from './chat/listener.js';
import { createChatSender } from './microsoft/chatSend.js';
import { assertTimeZone } from './time.js';
import { createIcsCalendarSource, todaysCalendar } from './outlook/calendar.js';

setLogLevel(config.logLevel);
assertTimeZone(config.briefingTimeZone);

const db = openDb(config.dbPath);
logger.info('db opened', { path: config.dbPath });
const store = createStore(db);
const scheduler = createScheduler();
const integrations = integrationStatus(config);

// ─── Claude (optional) and Teams notifications ───────────────────────────────
const pmoContext = config.pmoContextFile ? readPmoContext(config.pmoContextFile) : '';
const claude = createClaude({
  store,
  apiKey: config.anthropicApiKey,
  model: config.claudeModel,
  enabled: config.claudeEnabled,
  dailyCallLimit: config.claudeDailyCallLimit,
  pmoContext,
});
if (config.claudeEnabled && !config.anthropicApiKey) logger.warn('CLAUDE_ENABLED is on but ANTHROPIC_API_KEY is empty; using rule-based text');
const reasoner = config.priorityUseClaude && claude.enabled ? createClaudeReasoner({ store, claude }) : null;

const notifier = createTeamsNotifier({ webhookUrl: config.teamsWebhookUrl });
if (!notifier.configured) logger.warn('TEAMS_WEBHOOK_URL not set: briefings and alerts are logged, not sent (dry run)');

// Every sync is followed by turning changed items into action items,
// re-ranking, and delivering any new urgent alerts (each only once).
const thenActions = (sync) => async () => {
  const result = await sync();
  const actions = syncActions(store);
  const { counts, newAlerts } = await runPriorityEngine(store, { reasoner, raiseAlerts: true });
  const notified = await notifyPendingAlerts(store, notifier);
  return { ...result, actions, priorities: counts, newAlerts: newAlerts.length, notified: notified.length };
};

function readPmoContext(path) {
  try {
    return readFileSync(path, 'utf8').slice(0, 40_000);
  } catch (err) {
    logger.warn('PMO_CONTEXT_FILE unreadable; continuing without it', { error: err.message });
    return '';
  }
}

let jiraClient = null;
if (integrations.jira) {
  jiraClient = createJiraClient(config.jira);
  scheduler.every('jira', config.syncMinutes.jira, thenActions(() => syncJira({ client: jiraClient, store, jira: config.jira })));
  if (!config.jira.projects.length) {
    logger.warn('JIRA_PROJECTS is empty: production bugs and releases are not tracked, only issues involving you');
  }
} else {
  logger.info('jira not configured; skipping (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
}

let graph = null;
let msAuth = null;
if (integrations.microsoft) {
  msAuth = createMsAuth({ ...config.ms, scopes: msScopes(config.ms, config.teamsChat) });
  if (!msAuth.hasToken()) {
    logger.warn('microsoft not signed in; run `npm run ms:login`, then restart');
  } else {
    graph = createGraphClient(msAuth);
    if (config.ms.outlookEnabled) {
      scheduler.every('outlook', config.syncMinutes.outlook, thenActions(() => syncOutlook({ graph, store, ms: config.ms })), { initialDelayMs: 8_000 });
    }
    if (config.ms.teamsEnabled) {
      scheduler.every('teams', config.syncMinutes.teams, thenActions(() => syncTeams({ graph, store, ms: config.ms })), { initialDelayMs: 11_000 });
    }
  }
} else {
  logger.info('microsoft not configured; skipping Outlook, Teams, calendar and Teams chat (set MS_TENANT_ID, MS_CLIENT_ID)');
}

// Calendar: Graph when signed in (richer: attendees, responses), otherwise the
// published Outlook ICS feed, which needs no IT approval.
let calendarSource = null;
if (graph && config.ms.calendarEnabled) {
  calendarSource = ({ now }) => todaysCalendar(graph, { timeZone: config.briefingTimeZone, now });
} else if (config.outlookIcsUrl) {
  calendarSource = createIcsCalendarSource({ url: config.outlookIcsUrl, timeZone: config.briefingTimeZone, myEmails: [config.myEmail] });
  logger.info('calendar: using the published Outlook calendar feed');
} else {
  logger.warn('calendar not connected: set OUTLOOK_ICS_URL (see README) or sign in to Microsoft');
}

const briefings = createBriefingService({
  store, claude, notifier,
  timeZone: config.briefingTimeZone,
  live: {
    jiraClient, graph, scopes: config.pmoScopes,
    jiraEnabled: Boolean(jiraClient),
    outlookEnabled: Boolean(graph && config.ms.outlookEnabled),
    teamsEnabled: Boolean(graph && config.ms.teamsEnabled),
    calendarEnabled: Boolean(graph && config.ms.calendarEnabled),
    calendar: calendarSource,
  },
});

// Two-way Teams chat: listen to one chat, answer your messages in it.
let chatListener = null;
if (config.teamsChat.chatId) {
  if (!graph) {
    logger.warn('TEAMS_CHAT_ID is set but Microsoft is not signed in; Teams chat is off until `npm run ms:login` and a restart');
  } else {
    const handler = createChatHandler({ store, claude, config, jiraClient, scheduler, calendar: calendarSource });
    const reply = config.teamsChat.replyMode === 'graph'
      ? createChatSender(msAuth, config.teamsChat.chatId)
      : (text) => notifier.send({ title: '🤖 PMO Assistant', body: text }).then((r) => {
        if (r.dryRun) throw new Error('TEAMS_WEBHOOK_URL is required for webhook reply mode');
        return r;
      });
    chatListener = createChatListener({
      graph, store, handler, reply,
      chatId: config.teamsChat.chatId,
      pollSeconds: config.teamsChat.pollSeconds,
      timeZone: config.briefingTimeZone,
      notifyAlert: () => notifyPendingAlerts(store, notifier),
    });
    chatListener.start();
  }
}

// Items stored before action derivation existed (or changed while offline).
syncActions(store);

// Briefings at their wall-clock times in BRIEFING_TIMEZONE; monitoring every 15 minutes.
const briefingSchedule = startBriefingSchedule({
  store, briefings, times: config.briefingTimes, days: config.briefingDays,
  timeZone: config.briefingTimeZone, graceMinutes: config.briefingGraceMinutes,
});
const monitorTimer = setInterval(() => {
  checkAndAlert({ store, config, scheduler, notifier, claude })
    .catch((err) => logger.error('monitor check failed', { error: err.message }));
}, 15 * 60_000);

process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err });
  process.exit(1);
});

// Express 5 also calls this callback when listening fails; 'error' below handles that.
const server = createApp(config, { db, store, scheduler, reasoner, notifier, claude, briefings, jiraClient }).listen(config.port, config.host, (err) => {
  if (err) return;
  logger.info('PMO assistant started', {
    url: `http://${config.host}:${config.port}`,
    integrations,
    claude: claude.enabled ? config.claudeModel : 'off',
    teamsNotifications: notifier.configured ? 'on' : 'dry run',
  });
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
  briefingSchedule.stop();
  chatListener?.stop();
  clearInterval(monitorTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
