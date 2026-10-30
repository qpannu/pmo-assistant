// Runs one Jira report now and prints it:
//   npm run report -- scrum                 (active sprints on JIRA_BOARD_ID named REPORT_SPRINT_PREFIX…)
//   npm run report -- scrum --sprint "RA 2.0"
//   npm run report -- scrum --json          (full structured output)
//   npm run report -- scrum --no-save       (don't record a snapshot)
//   npm run report -- releases              (unreleased Fix Versions with board work)
//   npm run report -- releases --version POS_7.46
// Read-only towards Jira. Safe to run while the server is running.

import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { createJiraClient } from '../src/jira/client.js';
import { createClaude } from '../src/claude/client.js';
import { runReport, REPORTS } from '../src/reports/index.js';

setLogLevel('warn');
const args = process.argv.slice(2);
const name = args[0];
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i > 0 ? args[i + 1] : undefined;
};
if (!name || !REPORTS.includes(name)) {
  console.error(`Usage: npm run report -- <${REPORTS.join('|')}> [--sprint <name|id>] [--version <name>] [--board <id>] [--json] [--no-save]`);
  process.exit(2);
}

const store = createStore(openDb(config.dbPath));
const client = config.jira.baseUrl && config.jira.apiToken ? createJiraClient(config.jira) : null;
const claude = createClaude({
  store, apiKey: config.anthropicApiKey, model: config.claudeModel,
  enabled: config.claudeEnabled, dailyCallLimit: config.claudeDailyCallLimit,
});

try {
  const { report, markdown } = await runReport(name, {
    client, store, claude, config,
    save: !args.includes('--no-save'),
    options: { sprint: opt('--sprint'), version: opt('--version'), board: opt('--board') },
  });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : markdown);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
