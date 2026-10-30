// Live, read-only check of the Outlook integration. Skipped until Microsoft is
// configured and signed in. Run with: npm run test:outlook   (writes nothing)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadConfig, msScopes } from '../src/config.js';
import { createMsAuth } from '../src/microsoft/auth.js';
import { createGraphClient } from '../src/microsoft/graph.js';
import { MAIL_SELECT, normalizeMessage } from '../src/outlook/normalize.js';
import { classifyEmail, myIdentity } from '../src/outlook/classify.js';

const config = loadConfig();
const skip = !config.ms.tenantId || !config.ms.clientId ? 'MS_TENANT_ID / MS_CLIENT_ID not set'
  : !existsSync(config.ms.tokenCachePath) ? 'not signed in: run `npm run ms:login`'
    : !config.ms.outlookEnabled ? 'MS_OUTLOOK_ENABLED=false' : false;

test('reads my profile and a small sample of Outlook mail', { skip, timeout: 60_000 }, async (t) => {
  const graph = createGraphClient(createMsAuth({ ...config.ms, scopes: msScopes(config.ms, config.teamsChat) }));
  const me = await graph.me();
  assert.ok(me.id);
  t.diagnostic(`signed in as ${me.displayName}`);

  const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const res = await graph.collect('/me/mailFolders/inbox/messages/delta', {
    query: { $select: MAIL_SELECT, $filter: `receivedDateTime ge ${since}` },
    headers: { Prefer: 'odata.maxpagesize=10' },
    limit: 10,
  });
  assert.ok(res.deltaLink || res.nextLink, 'delta query supported');
  const identity = myIdentity(me);
  const msgs = res.items.filter((m) => !m['@removed']).map((m) => normalizeMessage(m, 'inbox'));
  t.diagnostic(`inbox delta OK: ${msgs.length} message(s) from the last 2 days in the first page`);
  let flagged = 0;
  for (const msg of msgs) {
    const { signals } = classifyEmail(msg, [msg], identity, config.ms);
    if (signals.length) flagged++;
  }
  t.diagnostic(`${flagged} of ${msgs.length} would need attention by the current rules`);

  const sent = await graph.get('/me/mailFolders/sentitems/messages', { query: { $select: 'id', $top: 1 } });
  assert.ok(Array.isArray(sent.value), 'sent items readable');
  t.diagnostic('sent items readable');
});
