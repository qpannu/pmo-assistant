// Sends a briefing to your Teams chat right now, with fresh Jira data:
//   npm run briefing:test            (morning)
//   npm run briefing:test -- midday  (or eod)
// Uses the same code path as the 7:00 AM schedule. Stop the server first if
// it's running, or use POST /briefings/<kind>/run instead.

import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { createJiraClient } from '../src/jira/client.js';
import { syncJira } from '../src/jira/sync.js';
import { syncActions } from '../src/actions.js';
import { createClaude } from '../src/claude/client.js';
import { createTeamsNotifier } from '../src/notify/teams.js';
import { createBriefingService } from '../src/briefing/briefing.js';
import { createIcsCalendarSource } from '../src/outlook/calendar.js';

setLogLevel('warn');
const kind = process.argv[2] ?? 'morning';
const store = createStore(openDb(config.dbPath));

let jiraClient = null;
if (config.jira.baseUrl && config.jira.apiToken) {
  jiraClient = createJiraClient(config.jira);
  await syncJira({ client: jiraClient, store, jira: config.jira }).catch((err) => console.warn(`Jira sync failed: ${err.message}`));
  syncActions(store);
}

const claude = createClaude({
  store, apiKey: config.anthropicApiKey, model: config.claudeModel,
  enabled: config.claudeEnabled, dailyCallLimit: config.claudeDailyCallLimit,
});
const notifier = createTeamsNotifier({ webhookUrl: config.teamsWebhookUrl });
const calendar = config.outlookIcsUrl
  ? createIcsCalendarSource({ url: config.outlookIcsUrl, timeZone: config.briefingTimeZone, myEmails: [config.myEmail] })
  : null;
const briefings = createBriefingService({
  store, claude, notifier, timeZone: config.briefingTimeZone,
  live: { jiraClient, scopes: config.pmoScopes, jiraEnabled: Boolean(jiraClient), calendar },
});

const r = await briefings.run(kind, { force: true });
if (r.sent) console.log(`✔ ${kind} briefing sent to Teams (${r.method}). Check your Workflows chat.`);
else if (r.dryRun) console.log('✖ Not sent: TEAMS_WEBHOOK_URL is empty in .env');
else console.log(`✖ Not sent: ${r.error ?? r.skipped}`);
process.exit(r.sent ? 0 : 1);
