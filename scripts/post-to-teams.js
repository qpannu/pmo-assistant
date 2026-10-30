// Posts a message you (or Claude, in a session with your Microsoft 365
// connector) wrote to your Teams Workflows chat, via TEAMS_WEBHOOK_URL:
//   npm run teams:post -- <file.md> ["Title"]
//   cat summary.md | npm run teams:post -- - ["Title"]
// The text is Teams card markdown: **bold**, - bullets, [links](https://…); no tables.

import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { setLogLevel } from '../src/logger.js';
import { createTeamsNotifier } from '../src/notify/teams.js';

setLogLevel('warn');
const [file, title = '☀️ Your day'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run teams:post -- <file.md | -> ["Title"]');
  process.exit(2);
}

const body = readFileSync(file === '-' ? 0 : file, 'utf8').trim();
if (!body) {
  console.error('✖ Nothing to post: the message is empty');
  process.exit(2);
}
if (!config.teamsWebhookUrl) {
  console.error('✖ Not sent: TEAMS_WEBHOOK_URL is empty in .env');
  process.exit(1);
}

try {
  await createTeamsNotifier({ webhookUrl: config.teamsWebhookUrl }).send({ title, body });
  console.log('✔ Posted to Teams. Check your Workflows chat.');
} catch (err) {
  console.error(`✖ Not sent: ${err.message}`);
  process.exit(1);
}
