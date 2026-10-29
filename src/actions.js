// Turns rule-based signals from any source (Jira, Outlook, Teams) into the
// shared action-item model.
//
// Deduplication: every action has a subject — the Jira issue it is about (when
// a message references exactly one tracked issue), otherwise its email
// conversation / chat / thread. Actions with the same subject and type merge
// into one item, with every source linked so the originals stay reachable.
//
// Resolution: when no source still triggers an action (I replied, the bug was
// fixed…), it is closed automatically. Items I closed myself never reopen.

import { logger } from './logger.js';
import { truncate } from './text.js';

const log = logger.child({ component: 'actions' });

function subjectKey(item, jiraKeys) {
  const d = item.data;
  if (item.source === 'jira') return item.kind === 'release' ? `jira:release:${d.id}` : `jira:${d.key}`;
  const tracked = (d.jiraKeys ?? []).filter((k) => jiraKeys.has(k));
  if (tracked.length === 1) return `jira:${tracked[0]}`;
  return `${item.source}:${item.thread_key ?? item.external_id}`;
}

const clampPriority = (p) => Math.min(4, Math.max(1, p));

function jiraActions(item) {
  const d = item.data;
  if (!d.tracked) return [];
  if (item.kind === 'release') {
    if (d.risk === 'critical') return [{ type: 'prioritize', priority: 1, title: `Release at risk: ${item.title}`, summary: d.reasons.join('; '), dueAt: d.releaseDate }];
    if (d.risk === 'warning') return [{ type: 'review', priority: 2, title: `Release needs attention: ${item.title}`, summary: d.reasons.join('; '), dueAt: d.releaseDate }];
    return [];
  }
  const s = new Set(d.signals);
  const label = `${d.key}: ${truncate(d.summary, 80)}`;
  const out = [];
  if (s.has('production_blocker')) out.push({ type: 'prioritize', priority: 1, title: `Production blocker ${label}`, summary: `${d.status} · ${d.assignee?.name ?? 'unassigned'}` });
  if (s.has('awaiting_my_decision')) out.push({ type: 'decide', priority: 2, title: `Decision needed on ${label}` });
  if (s.has('awaiting_my_reply')) {
    const c = d.recentComments.at(-1);
    out.push({ type: 'respond', priority: 2, title: `Reply on ${label}`, summary: c ? `${c.author?.name}: ${truncate(c.text, 200)}` : null });
  }
  if (s.has('overdue')) out.push({ type: 'follow_up', priority: 2, title: `Overdue: ${label}`, dueAt: d.dueDate });
  else if (s.has('blocked') && s.has('assigned_to_me')) out.push({ type: 'follow_up', priority: 2, title: `Unblock ${label}`, summary: d.blockedBy.map((b) => `blocked by ${b.key}`).join(', ') || d.status });
  else if (s.has('due_soon')) out.push({ type: 'follow_up', priority: 3, title: `Due soon: ${label}`, dueAt: d.dueDate });
  return out;
}

// Outlook and Teams share one signal vocabulary (see outlook/classify.js, teams/classify.js).
function messageActions(item) {
  const d = item.data;
  const s = new Set(d.signals ?? []);
  if (!s.size) return [];
  const who = d.from?.name ?? 'someone';
  const where = item.source === 'teams' ? ` in ${d.chatTopic || (d.chatType === 'oneOnOne' ? 'chat' : 'Teams')}` : '';
  const topic = truncate(item.source === 'outlook' ? d.subject || '(no subject)' : d.text, 90);
  const summary = truncate(item.source === 'outlook' ? d.preview : d.text, 240);
  const bump = s.has('urgent') ? 1 : s.has('release_related') ? 2 : null;
  const prio = (p) => clampPriority(bump ? Math.min(p, bump) : p);
  const dueAt = d.dueDate ?? null;

  const out = [];
  if (s.has('approval_requested')) out.push({ type: 'decide', priority: prio(2), title: `Approval requested by ${who}${where}: ${topic}`, summary, dueAt });
  else if (s.has('decision_requested')) out.push({ type: 'decide', priority: prio(2), title: `Decision requested by ${who}${where}: ${topic}`, summary, dueAt });
  if (s.has('response_needed')) out.push({ type: 'respond', priority: prio(3), title: `Reply to ${who}${where}: ${topic}`, summary, dueAt });
  if (s.has('urgent_discussion')) out.push({ type: 'review', priority: prio(2), title: `Urgent discussion${where}: ${topic}`, summary });
  if (s.has('flagged')) out.push({ type: 'follow_up', priority: prio(3), title: `Flagged: ${topic}`, summary, dueAt });
  if (s.has('my_commitment')) out.push({ type: 'follow_up', priority: prio(3), title: `You committed${where}: ${topic}`, summary, dueAt });
  if (s.has('awaiting_their_reply')) out.push({ type: 'follow_up', priority: 4, title: `No reply yet${where}: ${topic}`, summary });
  return out;
}

export function deriveActions(item, { jiraKeys = new Set(), jiraProjects = new Map() } = {}) {
  const raw = item.source === 'jira' ? jiraActions(item) : messageActions(item);
  const subject = subjectKey(item, jiraKeys);
  const byKey = new Map();
  for (const a of raw) {
    const dedupeKey = `${subject}:${a.type}`;
    if (byKey.has(dedupeKey)) continue; // e.g. flagged + commitment in one email → one follow-up
    const issueKey = subject.startsWith('jira:') && !subject.startsWith('jira:release:') ? subject.slice(5) : null;
    byKey.set(dedupeKey, {
      dedupeKey,
      type: a.type,
      title: a.title,
      summary: a.summary ?? null,
      priority: a.priority,
      dueAt: a.dueAt ?? null,
      project: item.project ?? (issueKey ? jiraProjects.get(issueKey) ?? issueKey.split('-')[0] : null),
    });
  }
  return [...byKey.values()];
}

// Processes every item whose content changed since actions were last derived.
export function syncActions(store) {
  const stats = { items: 0, created: 0, updated: 0, reopened: 0, resolved: 0 };
  const jiraIssues = store.listItems({ source: 'jira', kind: 'issue' }).filter((i) => i.data.tracked);
  const ctx = {
    jiraKeys: new Set(jiraIssues.map((i) => i.data.key)),
    jiraProjects: new Map(jiraIssues.map((i) => [i.data.key, i.data.project])),
  };

  store.transaction(() => {
    for (const item of store.itemsNeedingActions()) {
      stats.items++;
      const desired = deriveActions(item, ctx);
      const desiredKeys = new Set(desired.map((a) => a.dedupeKey));

      for (const a of desired) {
        const r = store.upsertActionItem({ ...a, itemId: item.id });
        store.linkActionSource(r.id, item.id);
        if (r.created) stats.created++;
        else stats.updated++;
        if (r.reopened) stats.reopened++;
      }

      for (const existing of store.actionsForItem(item.id)) {
        if (desiredKeys.has(existing.dedupe_key)) continue;
        store.unlinkActionSource(existing.id, item.id);
        const stillOpen = existing.status === 'open' || existing.status === 'snoozed';
        if (stillOpen && store.countActionSources(existing.id) === 0) {
          store.setActionStatus(existing.id, 'done', { reason: 'auto' });
          stats.resolved++;
        }
      }
      store.markActionsDerived(item.id, item.content_hash);
    }
  });

  if (stats.items) log.info('action items updated', stats);
  return stats;
}
