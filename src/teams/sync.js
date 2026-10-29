// Teams → local store, incrementally:
// - Chats: list chats by latest activity and stop at the last checkpoint, then
//   fetch only messages modified since each chat's own cursor. (Graph offers
//   no delegated delta for chat messages without metered APIs.)
// - Channels (optional, MS_TEAMS_CHANNELS): Graph delta query per channel,
//   plus replies of threads that changed.

import { logger } from '../logger.js';
import { normalizeChatMessage } from './normalize.js';
import { classifyChatMessage } from './classify.js';
import { myIdentity } from '../outlook/classify.js';

const log = logger.child({ component: 'teams-sync' });
const SOURCE = 'teams';
const RECLASSIFY_DAYS = 31;
const CHECKPOINT_OVERLAP_MS = 5 * 60_000;
const MAX_PER_CHAT = 200;

const isExpiredDelta = (err) => err.status === 410 || /syncState|resyncRequired/i.test(err.code ?? '');
const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function syncTeams({ graph, store, ms, now = new Date() }) {
  const started = Date.now();
  try {
    const result = await runSync({ graph, store, ms, now });
    log.info('teams sync complete', { ...result, ms: Date.now() - started });
    return result;
  } catch (err) {
    store.saveSyncError(SOURCE, err.message);
    log.error('teams sync failed', { err, ms: Date.now() - started });
    throw err;
  }
}

async function fetchChats(graph, cursor, ms, now, lookback, budget) {
  const checkpoint = cursor.chatsCheckedAt
    ? new Date(Date.parse(cursor.chatsCheckedAt) - CHECKPOINT_OVERLAP_MS).toISOString()
    : lookback;
  const { items: chats } = await graph.collect('/me/chats', {
    query: { $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc', $top: 50 },
    limit: 2000,
    stopWhen: (c) => (c.lastMessagePreview?.createdDateTime ?? '') < checkpoint,
  });

  const messages = [];
  let complete = true;
  for (const chat of chats) {
    if (messages.length >= budget) { complete = false; break; }
    const since = cursor.chats[chat.id] ?? lookback;
    const { items } = await graph.collect(`/me/chats/${encodeURIComponent(chat.id)}/messages`, {
      query: { $top: 50, $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${since}` },
      limit: MAX_PER_CHAT,
    });
    const where = { chatId: chat.id, chatType: chat.chatType, chatTopic: chat.topic ?? null };
    messages.push(...items.map((m) => ({ m, where })));
    const newest = items.reduce((max, m) => (m.lastModifiedDateTime > max ? m.lastModifiedDateTime : max), since);
    cursor.chats[chat.id] = newest;
  }
  if (complete) cursor.chatsCheckedAt = now.toISOString();
  return { messages, chats: chats.length, truncated: !complete };
}

async function resolveChannels(graph, names, known) {
  const wanted = names.filter((n) => !known[n]);
  if (!wanted.length) return;
  const { items: teams } = await graph.collect('/me/joinedTeams', { query: { $select: 'id,displayName' } });
  for (const full of wanted) {
    const [teamName, channelName] = full.split('/').map((s) => s.trim());
    const team = teams.find((t) => t.displayName?.toLowerCase() === teamName?.toLowerCase());
    if (!team) { log.warn('team not found among your teams', { channel: full }); continue; }
    const { items: channels } = await graph.collect(`/teams/${team.id}/channels`, { query: { $select: 'id,displayName' } });
    const ch = channels.find((c) => c.displayName?.toLowerCase() === channelName?.toLowerCase());
    if (!ch) { log.warn('channel not found', { channel: full }); continue; }
    known[full] = { teamId: team.id, channelId: ch.id, name: `${team.displayName} / ${ch.displayName}`, deltaLink: null };
  }
}

async function fetchChannels(graph, cursor, ms, lookback) {
  if (!ms.teamsChannels.length) return [];
  await resolveChannels(graph, ms.teamsChannels, cursor.channels);
  const messages = [];
  for (const name of ms.teamsChannels) {
    const c = cursor.channels[name];
    if (!c) continue;
    const where = { channel: { teamId: c.teamId, channelId: c.channelId, name: c.name } };
    const base = `/teams/${c.teamId}/channels/${c.channelId}/messages`;
    let res;
    try {
      res = c.deltaLink ? await graph.collect(c.deltaLink, { limit: ms.maxMessagesPerSync }) : null;
    } catch (err) {
      if (!isExpiredDelta(err)) throw err;
    }
    res ??= await graph.collect(`${base}/delta`, {
      query: { $top: 50, $filter: `lastModifiedDateTime gt ${lookback}` },
      limit: ms.maxMessagesPerSync,
    });
    c.deltaLink = res.deltaLink ?? res.nextLink ?? c.deltaLink;
    for (const root of res.items) {
      messages.push({ m: root, where });
      const { items: replies } = await graph.collect(`${base}/${root.id}/replies`, { query: { $top: 50 }, limit: MAX_PER_CHAT });
      messages.push(...replies.map((m) => ({ m, where })));
    }
  }
  return messages;
}

async function runSync({ graph, store, ms, now }) {
  const cursor = { chats: {}, channels: {}, ...JSON.parse(store.getSyncState(SOURCE)?.cursor ?? '{}') };
  const me = myIdentity(await graph.me());
  const lookback = new Date(now - ms.teamsLookbackDays * 86_400_000).toISOString();

  const chats = await fetchChats(graph, cursor, ms, now, lookback, ms.maxMessagesPerSync);
  const channelMessages = await fetchChannels(graph, cursor, ms, lookback);
  const fetched = [...chats.messages, ...channelMessages];
  const stats = { chatsChecked: chats.chats, fetched: fetched.length, newItems: 0, changedItems: 0, unchanged: 0, reclassified: 0, truncated: chats.truncated };

  store.transaction(() => {
    for (const { m, where } of fetched) {
      const msg = normalizeChatMessage(m, where);
      const existing = store.getItemByExternalId(SOURCE, msg.id);
      const r = store.upsertItem(record(msg, { ...msg, signals: existing?.data.signals ?? [], dueDate: existing?.data.dueDate ?? null }));
      if (r.isNew) stats.newItems++;
      else if (r.changed) stats.changedItems++;
      else stats.unchanged++;
    }

    // Re-evaluate recent messages per chat/thread (my replies, time windows).
    const since = new Date(now - RECLASSIFY_DAYS * 86_400_000).toISOString();
    const recent = store.listItemsSince(SOURCE, since);
    const threads = Map.groupBy(recent, (i) => i.thread_key);
    for (const item of recent) {
      const thread = threads.get(item.thread_key).map((i) => i.data);
      const { signals, dueDate } = classifyChatMessage(item.data, thread, me, ms, now);
      if (sameList(signals, item.data.signals) && dueDate === (item.data.dueDate ?? null)) continue;
      store.upsertItem(record(item.data, { ...item.data, signals, dueDate }));
      stats.reclassified++;
    }

    // Forget cursors of chats idle for longer than the lookback window.
    for (const [id, ts] of Object.entries(cursor.chats)) if (ts < since) delete cursor.chats[id];
    store.saveSyncSuccess(SOURCE, JSON.stringify(cursor));
  });

  if (stats.truncated) log.warn('teams sync hit MS_MAX_MESSAGES_PER_SYNC; the rest continues next run', { limit: ms.maxMessagesPerSync });
  return stats;
}

function record(msg, data) {
  return {
    source: SOURCE,
    externalId: msg.id,
    kind: 'chat_message',
    title: msg.subject || (msg.text ? msg.text.slice(0, 120) : '(no text)'),
    url: msg.webUrl,
    author: msg.from?.name ?? null,
    occurredAt: msg.createdAt,
    threadKey: msg.threadKey,
    data,
  };
}

export function teamsOverview(store) {
  const state = store.getSyncState(SOURCE);
  const since = new Date(Date.now() - RECLASSIFY_DAYS * 86_400_000).toISOString();
  const items = store.listItemsSince(SOURCE, since).filter((i) => i.data.signals?.length);
  const pick = (signal) => items.filter((i) => i.data.signals.includes(signal)).map((i) => ({
    from: i.author, where: i.data.chatTopic ?? i.data.chatType, text: i.data.text.slice(0, 160),
    at: i.occurred_at, signals: i.data.signals, url: i.url,
  }));
  return {
    lastSyncAt: state?.last_success_at ?? null,
    lastError: state?.last_error ?? null,
    responseNeeded: pick('response_needed'),
    approvalRequested: pick('approval_requested'),
    decisionRequested: pick('decision_requested'),
    urgentDiscussions: pick('urgent_discussion'),
    mentions: pick('mentioned_me'),
    myCommitments: pick('my_commitment'),
  };
}
