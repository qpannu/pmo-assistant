// Runs the priority engine on fictional sample data in an in-memory database:
// `npm run demo:priorities`. Touches no real system and makes no Claude call.

import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { runPriorityEngine } from '../src/priority/engine.js';
import { formatReport } from '../src/priority/format.js';
import { seedSample } from '../test/fixtures/sample-data.js';

setLogLevel('warn');
const store = createStore(openDb(':memory:'));
seedSample(store);

const first = await runPriorityEngine(store, { raiseAlerts: true });
process.stdout.write(formatReport(first));

const second = await runPriorityEngine(store, { raiseAlerts: true });
console.log(`\nSecond run: ${second.newAlerts.length} new alert(s) — duplicates suppressed (${store.listActiveAlerts().length} alert(s) on record).`);
