// Live, read-only status snapshot of a named Jira scope (e.g. ezCater), built
// from one JQL search. Cached for a few minutes so a burst of chat questions
// doesn't repeat the query.

import { normalizeIssue } from './normalize.js';
import { daysUntil, localToday } from './classify.js';
import { truncate } from '../text.js';

const FIELDS = ['summary', 'status', 'priority', 'issuetype', 'assignee', 'duedate', 'issuelinks', 'updated', 'labels', 'fixVersions', 'reporter', 'project', 'created', 'resolutiondate'];
const CACHE_MS = 5 * 60_000;
const LIMIT = 300;
const cache = new Map();

const count = (arr, key) => arr.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

export async function scopeSnapshot(client, name, jql, { now = new Date(), fresh = false } = {}) {
  const key = `${name}:${jql}`;
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;

  const { issues: raw, truncated } = await client.search({ jql, fields: FIELDS, limit: LIMIT });
  const today = localToday(now);
  const issues = raw.map((r) => ({ ...normalizeIssue(r), updated: r.fields?.updated, url: client.browseUrl(r.key) }));
  const brief = (i) => ({ key: i.key, summary: truncate(i.summary, 80), status: i.status, owner: i.assignee?.name ?? 'unassigned', url: i.url });

  const value = {
    name,
    asOf: now.toISOString(),
    total: issues.length,
    truncated,
    byStatus: Object.fromEntries(top(count(issues, (i) => i.status ?? 'Unknown'), 12)),
    byType: count(issues, (i) => i.type ?? 'Unknown'),
    owners: Object.fromEntries(top(count(issues, (i) => i.assignee?.name ?? 'unassigned'), 8)),
    blocked: issues.filter((i) => i.blockedBy.some((b) => !b.done) || /blocked|on hold/i.test(i.status ?? ''))
      .slice(0, 10).map((i) => ({ ...brief(i), blockedBy: i.blockedBy.filter((b) => !b.done).map((b) => b.key) })),
    unassigned: issues.filter((i) => !i.assignee).slice(0, 10).map(brief),
    highPriority: issues.filter((i) => ['Highest', 'High'].includes(i.priority)).slice(0, 10).map(brief),
    overdue: issues.filter((i) => i.dueDate && daysUntil(i.dueDate, today) < 0).slice(0, 10).map((i) => ({ ...brief(i), due: i.dueDate })),
    changedLast24h: issues.filter((i) => i.updated && now - Date.parse(i.updated) < 86_400_000).slice(0, 10).map(brief),
  };
  cache.set(key, { at: now, value });
  return value;
}

// Scope names mentioned in a question (case-insensitive, ignoring spaces).
export function scopesIn(text, scopes) {
  const t = text.toLowerCase().replace(/\s+/g, '');
  return Object.keys(scopes).filter((name) => t.includes(name.toLowerCase().replace(/\s+/g, '')));
}

export function clearScopeCache() {
  cache.clear();
}
