// Give feedback on what the reports raise, by the ref shown next to each follow-up:
//   npm run risk -- list [scrum|releases|features|prod]   (raised in the last 7 days)
//   npm run risk -- a1b2c3 valid ["note"]       keep showing it, ranked higher
//   npm run risk -- a1b2c3 dismissed ["why"]    hide until the facts change
//   npm run risk -- a1b2c3 resolved ["note"]    handled; flagged if Jira still shows it
//   npm run risk -- a1b2c3 clear                forget the verdict
// Changes only how reports rank and show follow-ups. Never changes Jira.

import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { setVerdict, recentRisks, VERDICTS } from '../src/reports/feedback.js';

setLogLevel('warn');
const [first, second, ...rest] = process.argv.slice(2);
const store = createStore(openDb(config.dbPath));

try {
  if (!first || first === 'list') {
    const rows = recentRisks(store, { report: second ?? null });
    console.log(`Raised in the last 7 days (${rows.length}):`);
    for (const r of rows) {
      console.log(`- ${r.ref} [${r.report}/${r.rule}] ${r.verdict ? `(${r.verdict}${r.verdict_note ? `: ${r.verdict_note}` : ''}) ` : ''}${r.text}`);
    }
  } else if ([...VERDICTS, 'clear'].includes(second)) {
    const row = setVerdict(store, first, second, rest.join(' ') || null);
    console.log(second === 'clear' ? `✔ ${row.ref}: verdict cleared` : `✔ ${row.ref} marked ${second}: ${row.text}`);
  } else {
    console.error(`Usage: npm run risk -- list [report] | <ref> ${VERDICTS.join('|')}|clear ["note"]`);
    process.exit(2);
  }
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
