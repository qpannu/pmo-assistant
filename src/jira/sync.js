// Jira → local store. Incremental by default: only issues updated since the
// last run are fetched (plus a small overlap), and items whose stored content
// is unchanged are left untouched, so nothing downstream re-processes them.
// A periodic full sync reconciles issues that dropped out of scope.

import { logger } from '../logger.js';
import { ISSUE_FIELDS, normalizeIssue, normalizeVersion } from './normalize.js';
import { compileRules, daysUntil, issueSignals, localToday, releaseRisk, SIGNALS } from './classify.js';

const log = logger.child({ component: 'jira-sync' });
const SOURCE = 'jira';
const OVERLAP_MINUTES = 2;

const quote = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
const inList = (values) => values.map(quote).join(', ');

export function buildRelevanceJql(jira, releaseIds = []) {
  const watching = jira.watcherActiveDays
    ? `(watcher = currentUser() AND updated >= -${jira.watcherActiveDays}d)`
    : 'watcher = currentUser()';
  const clauses = ['assignee = currentUser()', 'reporter = currentUser()', watching];
  if (jira.decisionLabels.length) clauses.push(`labels in (${inList(jira.decisionLabels)})`);
  if (jira.projects.length && jira.prodIssueTypes.length && jira.blockerPriorities.length) {
    let prod = `project in (${inList(jira.projects)}) AND issuetype in (${inList(jira.prodIssueTypes)}) AND priority in (${inList(jira.blockerPriorities)})`;
    if (jira.prodLabels.length) prod += ` AND labels in (${inList(jira.prodLabels)})`;
    clauses.push(`(${prod})`);
  }
  if (releaseIds.length) clauses.push(`fixVersion in (${releaseIds.join(', ')})`);
  return `(${clauses.join(' OR ')})`;
}

export async function syncJira({ client, store, jira, now = new Date() }) {
  const started = Date.now();
  try {
    const result = await runSync({ client, store, jira, now });
    log.info('jira sync complete', { ...result, ms: Date.now() - started });
    return result;
  } catch (err) {
    store.saveSyncError(SOURCE, err.message);
    log.error('jira sync failed', { err, ms: Date.now() - started });
    throw err;
  }
}

async function runSync({ client, store, jira, now }) {
  const cursor = JSON.parse(store.getSyncState(SOURCE)?.cursor ?? '{}');
  const today = localToday(now);
  const rules = compileRules(jira);
  const lastFull = cursor.lastFullSyncAt ? Date.parse(cursor.lastFullSyncAt) : 0;
  const full = !cursor.lastSyncAt || now - lastFull >= jira.fullSyncHours * 3_600_000;

  const me = await client.myself();

  // 1. Upcoming releases in watched projects: unreleased, due within the window or
  //    recently overdue. Long-overdue versions are usually abandoned, not late.
  const upcoming = [];
  for (const project of jira.projects) {
    const versions = await client.projectVersions(project);
    for (const v of versions) {
      const version = normalizeVersion(v, project);
      if (version.released || version.archived || !version.releaseDate) continue;
      const days = daysUntil(version.releaseDate, today);
      if (days <= jira.releaseWindowDays && days >= -jira.releaseOverdueDays) upcoming.push(version);
    }
  }
  const releaseIds = upcoming.map((v) => v.id);

  // 2. Fetch relevant issues: everything open on a full sync, otherwise only recent changes.
  const relevance = buildRelevanceJql(jira, releaseIds);
  const sinceMinutes = Math.ceil((now - Date.parse(cursor.lastSyncAt ?? now)) / 60_000) + OVERLAP_MINUTES;
  const jql = full
    ? `${relevance} AND statusCategory != Done ORDER BY updated DESC`
    : `${relevance} AND updated >= -${sinceMinutes}m ORDER BY updated DESC`;
  const { issues, truncated } = await client.search({ jql, fields: ISSUE_FIELDS, limit: jira.maxIssuesPerSync });

  // Releases that just entered the window: pull their open issues once, regardless of age.
  const known = new Set(cursor.releaseIds ?? []);
  const newReleaseIds = full ? [] : releaseIds.filter((id) => !known.has(id));
  if (newReleaseIds.length) {
    const extra = await client.search({
      jql: `fixVersion in (${newReleaseIds.join(', ')}) AND statusCategory != Done`,
      fields: ISSUE_FIELDS,
      limit: jira.maxIssuesPerSync,
    });
    issues.push(...extra.issues);
  }

  // 3. Store. Everything below is local — no further API calls.
  const stats = { mode: full ? 'full' : 'incremental', fetched: issues.length, newItems: 0, changedItems: 0, unchanged: 0, reclassified: 0, truncated };
  const count = (r) => {
    if (r.isNew) stats.newItems++;
    else if (r.changed) stats.changedItems++;
    else stats.unchanged++;
  };

  store.transaction(() => {
    const seen = new Set();
    for (const raw of issues) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const issue = normalizeIssue(raw);
      const updatedAt = raw.fields?.updated;
      count(store.upsertItem(issueRecord(client, raw.id, updatedAt, {
        ...issue, signals: issueSignals(issue, me.accountId, rules, { now, updatedAt }), tracked: true,
      })));
    }

    // Re-evaluate stored issues locally: time-based signals (overdue, due soon,
    // recency windows) change without the issue changing, and a full sync drops
    // issues no longer in scope.
    const stored = store.listItems({ source: SOURCE, kind: 'issue' });
    for (const item of stored) {
      if (seen.has(item.external_id) || !item.data.tracked) continue;
      const outOfScope = full && !truncated;
      const signals = outOfScope ? [] : issueSignals(item.data, me.accountId, rules, { now, updatedAt: item.occurred_at });
      if (!outOfScope && sameList(signals, item.data.signals)) continue;
      stats.reclassified++;
      store.upsertItem(issueRecord(client, item.external_id, item.occurred_at, {
        ...item.data, signals, tracked: !outOfScope,
      }));
    }

    // Release risk from the tracked issues in each upcoming release.
    const tracked = store.listItems({ source: SOURCE, kind: 'issue' }).filter((i) => i.data.tracked).map((i) => i.data);
    const upcomingIds = new Set(releaseIds);
    for (const version of upcoming) {
      const inRelease = tracked.filter((i) => i.fixVersions.some((f) => f.id === version.id));
      count(store.upsertItem(releaseRecord(client, version, { ...version, ...releaseRisk(version, inRelease, rules, today), tracked: true })));
    }
    if (jira.projects.length) {
      for (const item of store.listItems({ source: SOURCE, kind: 'release' })) {
        if (upcomingIds.has(item.data.id) || !item.data.tracked) continue;
        store.upsertItem(releaseRecord(client, item.data, { ...item.data, risk: 'none', reasons: [], tracked: false }));
      }
    }

    // A truncated full sync is incomplete, so the next run tries a full sync again.
    store.saveSyncSuccess(SOURCE, JSON.stringify({
      lastSyncAt: now.toISOString(),
      lastFullSyncAt: full && !truncated ? now.toISOString() : cursor.lastFullSyncAt,
      releaseIds,
    }));
  });
  if (truncated) {
    log.warn('jira sync hit JIRA_MAX_ISSUES_PER_SYNC; raise it or narrow the scope', { limit: jira.maxIssuesPerSync, mode: stats.mode });
  }

  stats.releases = upcoming.length;
  return stats;
}

function issueRecord(client, id, updated, data) {
  return {
    source: SOURCE,
    externalId: String(id),
    kind: 'issue',
    title: `${data.key}: ${data.summary}`,
    url: client.browseUrl(data.key),
    author: data.reporter?.name ?? null,
    project: data.project,
    occurredAt: updated ?? null,
    data,
  };
}

function releaseRecord(client, version, data) {
  return {
    source: SOURCE,
    externalId: `version:${version.id}`,
    kind: 'release',
    title: `${version.project} ${version.name}`,
    url: client.versionUrl(version.project, version.id),
    project: version.project,
    occurredAt: version.releaseDate,
    data,
  };
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

// What the assistant currently knows from Jira, grouped for display and for Claude.
export function jiraOverview(store) {
  const issues = store.listItems({ source: SOURCE, kind: 'issue' }).filter((i) => i.data.tracked);
  const pick = (signal) => issues
    .filter((i) => i.data.signals.includes(signal))
    .map((i) => ({
      key: i.data.key, summary: i.data.summary, status: i.data.status, priority: i.data.priority,
      assignee: i.data.assignee?.name ?? null, dueDate: i.data.dueDate, url: i.url, signals: i.data.signals,
    }));
  const releases = store.listItems({ source: SOURCE, kind: 'release' })
    .filter((r) => r.data.tracked)
    .map((r) => ({
      name: r.title, releaseDate: r.data.releaseDate, daysLeft: r.data.daysLeft, risk: r.data.risk,
      reasons: r.data.reasons, openIssues: r.data.openIssues, url: r.url,
    }))
    .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''));

  const state = store.getSyncState(SOURCE);
  const cursor = JSON.parse(state?.cursor ?? '{}');
  return {
    lastSyncAt: cursor.lastSyncAt ?? null,
    lastError: state?.last_error ?? null,
    trackedIssues: issues.length,
    assignedToMe: pick(SIGNALS.ASSIGNED_TO_ME),
    awaitingMyDecision: pick(SIGNALS.AWAITING_DECISION),
    awaitingMyReply: pick(SIGNALS.AWAITING_REPLY),
    overdue: pick(SIGNALS.OVERDUE),
    dueSoon: pick(SIGNALS.DUE_SOON),
    productionBlockers: pick(SIGNALS.PRODUCTION_BLOCKER),
    blocked: pick(SIGNALS.BLOCKED),
    releases,
    releasesAtRisk: releases.filter((r) => r.risk !== 'none'),
  };
}
