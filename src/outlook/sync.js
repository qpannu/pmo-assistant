// Outlook → local store using Graph delta queries on Inbox and Sent Items:
// after the first run only new, changed or deleted messages are returned.
// Sent mail is kept to know whether I already replied and what I promised.

import { logger } from '../logger.js';
import { MAIL_SELECT, normalizeMessage } from './normalize.js';
import { classifyEmail, myIdentity } from './classify.js';

const log = logger.child({ component: 'outlook-sync' });
const SOURCE = 'outlook';
const FOLDERS = ['inbox', 'sentitems'];
const RECLASSIFY_DAYS = 31; // local re-evaluation window for time-based signals
const PAGE_SIZE = 50;

const isExpiredDelta = (err) => err.status === 410 || /syncState|resyncRequired/i.test(err.code ?? '');
const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function syncOutlook({ graph, store, ms, now = new Date() }) {
  const started = Date.now();
  try {
    const result = await runSync({ graph, store, ms, now });
    log.info('outlook sync complete', { ...result, ms: Date.now() - started });
    return result;
  } catch (err) {
    store.saveSyncError(SOURCE, err.message);
    log.error('outlook sync failed', { err, ms: Date.now() - started });
    throw err;
  }
}

async function fetchFolder(graph, folder, cursorLink, ms, now) {
  const since = new Date(now - ms.mailLookbackDays * 86_400_000).toISOString();
  const opts = { headers: { Prefer: `odata.maxpagesize=${PAGE_SIZE}` }, limit: ms.maxMessagesPerSync };
  if (cursorLink) {
    try {
      return { ...(await graph.collect(cursorLink, opts)), reset: false };
    } catch (err) {
      if (!isExpiredDelta(err)) throw err;
      log.warn('delta link expired; starting over', { folder });
    }
  }
  const res = await graph.collect(`/me/mailFolders/${folder}/messages/delta`, {
    ...opts,
    query: { $select: MAIL_SELECT, $filter: `receivedDateTime ge ${since}` },
  });
  return { ...res, reset: true };
}

async function runSync({ graph, store, ms, now }) {
  const cursor = JSON.parse(store.getSyncState(SOURCE)?.cursor ?? '{}');
  const me = myIdentity(await graph.me());
  const stats = { fetched: 0, newItems: 0, changedItems: 0, unchanged: 0, removed: 0, reclassified: 0, truncated: false };

  const fetched = [];
  for (const folder of FOLDERS) {
    const res = await fetchFolder(graph, folder, cursor[folder], ms, now);
    cursor[folder] = res.deltaLink ?? res.nextLink ?? cursor[folder];
    if (res.truncated) stats.truncated = true;
    fetched.push(...res.items.map((m) => ({ m, folder })));
  }
  stats.fetched = fetched.length;

  store.transaction(() => {
    // 1. Store what changed, keeping each message's current signals for now.
    for (const { m, folder } of fetched) {
      const existing = store.getItemByExternalId(SOURCE, m.id);
      if (m['@removed']) {
        if (existing && !existing.data.removed) {
          store.upsertItem(record(existing.data, { ...existing.data, removed: true, signals: [] }));
          stats.removed++;
        }
        continue;
      }
      const msg = normalizeMessage(m, folder);
      const r = store.upsertItem(record(msg, { ...msg, signals: existing?.data.signals ?? [], dueDate: existing?.data.dueDate ?? null }));
      if (r.isNew) stats.newItems++;
      else if (r.changed) stats.changedItems++;
      else stats.unchanged++;
    }

    // 2. Re-evaluate recent messages per conversation: a reply I sent, an answer
    //    I received, or time passing all change what needs attention.
    const since = new Date(now - RECLASSIFY_DAYS * 86_400_000).toISOString();
    const recent = store.listItemsSince(SOURCE, since);
    const threads = Map.groupBy(recent, (i) => i.thread_key);
    for (const item of recent) {
      const thread = threads.get(item.thread_key).map((i) => i.data);
      const { signals, dueDate } = classifyEmail(item.data, thread, me, ms, now);
      if (sameList(signals, item.data.signals) && dueDate === (item.data.dueDate ?? null)) continue;
      store.upsertItem(record(item.data, { ...item.data, signals, dueDate }));
      stats.reclassified++;
    }

    store.saveSyncSuccess(SOURCE, JSON.stringify(cursor));
  });

  if (stats.truncated) log.warn('outlook sync hit MS_MAX_MESSAGES_PER_SYNC; the rest continues next run', { limit: ms.maxMessagesPerSync });
  return stats;
}

function record(msg, data) {
  return {
    source: SOURCE,
    externalId: msg.id,
    kind: msg.folder === 'sentitems' ? 'sent_email' : 'email',
    title: msg.subject || '(no subject)',
    url: msg.webLink,
    author: msg.from?.name ?? msg.from?.address ?? null,
    occurredAt: msg.folder === 'sentitems' ? msg.sentAt : msg.receivedAt,
    threadKey: msg.conversationId,
    data,
  };
}

export function outlookOverview(store) {
  const state = store.getSyncState(SOURCE);
  const since = new Date(Date.now() - RECLASSIFY_DAYS * 86_400_000).toISOString();
  const items = store.listItemsSince(SOURCE, since).filter((i) => i.data.signals?.length);
  const pick = (signal) => items.filter((i) => i.data.signals.includes(signal)).map((i) => ({
    subject: i.title, from: i.data.from?.name ?? i.data.from?.address, at: i.occurred_at,
    dueDate: i.data.dueDate, signals: i.data.signals, url: i.url,
  }));
  return {
    lastSyncAt: state?.last_success_at ?? null,
    lastError: state?.last_error ?? null,
    responseNeeded: pick('response_needed'),
    approvalRequested: pick('approval_requested'),
    decisionRequested: pick('decision_requested'),
    flagged: pick('flagged'),
    myCommitments: pick('my_commitment'),
    awaitingTheirReply: pick('awaiting_their_reply'),
  };
}
