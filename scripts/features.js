// Manage the features (initiatives) the Feature report tracks — no code changes needed:
//   npm run features -- list
//   npm run features -- add REST-12345 ["optional note"]
//   npm run features -- remove REST-12345
// The list lives in the database and survives restarts. Removing keeps its history.
// Reads Jira to verify keys; never changes Jira.

import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { createJiraClient } from '../src/jira/client.js';
import { listFeatures, addFeature, removeFeature } from '../src/reports/registry.js';

setLogLevel('warn');
const [cmd = 'list', key, ...rest] = process.argv.slice(2);
const store = createStore(openDb(config.dbPath));
const client = config.jira.baseUrl && config.jira.apiToken ? createJiraClient(config.jira) : null;

try {
  if (cmd === 'list') {
    const { tracked, removed } = listFeatures(store, config);
    console.log(`Tracked features (${tracked.length}):`);
    for (const f of tracked) console.log(`- ${f.key} — ${f.summary ?? '(not verified yet)'}${f.issue_type ? ` [${f.issue_type}]` : ''} — since ${f.added_at.slice(0, 10)}${f.note ? ` — ${f.note}` : ''}`);
    if (removed.length) console.log(`Removed (history kept): ${removed.map((f) => `${f.key} (${f.removed_at.slice(0, 10)})`).join(', ')}`);
  } else if (cmd === 'add') {
    const r = await addFeature({ store, config, client, key, note: rest.join(' ') || null });
    console.log(`✔ ${r.key} ${r.result === 'exists' ? 'is already tracked' : r.result === 'restored' ? 'is tracked again' : 'added'}${r.summary ? ` — ${r.summary} [${r.type}]` : ''}`);
    for (const w of r.warnings) console.log(`⚠️ ${w}`);
  } else if (cmd === 'remove') {
    removeFeature({ store, config, key });
    console.log(`✔ ${String(key).toUpperCase()} is no longer tracked (its report history is kept)`);
  } else {
    console.error('Usage: npm run features -- list | add <KEY> [note] | remove <KEY>');
    process.exit(2);
  }
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
