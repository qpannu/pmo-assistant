// Live, read-only check of the Teams integration. Skipped until Microsoft is
// configured and signed in. Run with: npm run test:teams   (writes nothing)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadConfig, msScopes } from '../src/config.js';
import { createMsAuth } from '../src/microsoft/auth.js';
import { createGraphClient } from '../src/microsoft/graph.js';
import { normalizeChatMessage } from '../src/teams/normalize.js';
import { classifyChatMessage } from '../src/teams/classify.js';
import { myIdentity } from '../src/outlook/classify.js';

const config = loadConfig();
const skip = !config.ms.tenantId || !config.ms.clientId ? 'MS_TENANT_ID / MS_CLIENT_ID not set'
  : !existsSync(config.ms.tokenCachePath) ? 'not signed in: run `npm run ms:login`'
    : !config.ms.teamsEnabled ? 'MS_TEAMS_ENABLED=false' : false;

test('reads recent chats and a small sample of messages', { skip, timeout: 60_000 }, async (t) => {
  const graph = createGraphClient(createMsAuth({ ...config.ms, scopes: msScopes(config.ms, config.teamsChat) }));
  const me = myIdentity(await graph.me());

  const chats = await graph.get('/me/chats', {
    query: { $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc', $top: 5 },
  });
  assert.ok(Array.isArray(chats.value));
  t.diagnostic(`chats OK: ${chats.value.length} most recent (${chats.value.map((c) => c.chatType).join(', ')})`);

  const chat = chats.value[0];
  if (!chat) return;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const msgs = await graph.get(`/me/chats/${encodeURIComponent(chat.id)}/messages`, {
    query: { $top: 10, $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${since}` },
  });
  assert.ok(Array.isArray(msgs.value), 'incremental message filter supported');
  const normalized = msgs.value.map((m) => normalizeChatMessage(m, { chatId: chat.id, chatType: chat.chatType, chatTopic: chat.topic }));
  const flagged = normalized.filter((m) => classifyChatMessage(m, normalized, me, config.ms).signals.length).length;
  t.diagnostic(`latest chat: ${normalized.length} message(s) in 7 days, ${flagged} with signals; links: ${normalized[0]?.webUrl ? 'yes' : 'n/a'}`);
});

test('configured channels are reachable', { skip: skip || (!config.ms.teamsChannels.length && 'MS_TEAMS_CHANNELS not set'), timeout: 60_000 }, async (t) => {
  const graph = createGraphClient(createMsAuth({ ...config.ms, scopes: msScopes(config.ms, config.teamsChat) }));
  const teams = await graph.get('/me/joinedTeams', { query: { $select: 'id,displayName' } });
  for (const full of config.ms.teamsChannels) {
    const [teamName, channelName] = full.split('/').map((s) => s.trim());
    const team = teams.value.find((x) => x.displayName?.toLowerCase() === teamName.toLowerCase());
    assert.ok(team, `team "${teamName}" found`);
    const channels = await graph.get(`/teams/${team.id}/channels`, { query: { $select: 'id,displayName' } });
    const ch = channels.value.find((c) => c.displayName?.toLowerCase() === channelName.toLowerCase());
    assert.ok(ch, `channel "${channelName}" found`);
    const page = await graph.get(`/teams/${team.id}/channels/${ch.id}/messages/delta`, { query: { $top: 5 } });
    t.diagnostic(`${full}: delta OK (${page.value.length} message(s) in first page)`);
  }
});
