// Compact, incremental inputs for briefings: only what Claude needs to write
// them (ranked items, reasons, next steps, what changed) — no raw emails.
// Every section says whether its data is available, so missing information is
// reported as missing instead of guessed.

import { truncate } from '../text.js';
import { dayKey, zonedTimeToUtc } from '../time.js';
import { todaysMeetings, prepHints } from '../outlook/calendar.js';
import { scopeSnapshot } from '../jira/scope.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'briefing-context' });
const SECTION = { critical: 'critical', waiting_on_me: 'waiting', release_risks: 'release', follow_ups: 'follow-up' };

// Long URLs are replaced by short ids (L1, L2…) in what Claude sees, then restored.
export function createLinkTable() {
  const urls = [];
  const byUrl = new Map();
  return {
    ref(url) {
      if (!url) return undefined;
      if (!byUrl.has(url)) {
        urls.push(url);
        byUrl.set(url, `L${urls.length}`);
      }
      return byUrl.get(url);
    },
    // Replaces (L3) / [L3] references with real URLs.
    expand(text) {
      return text.replace(/\((L\d+)\)/g, (m, id) => {
        const url = urls[Number(id.slice(1)) - 1];
        return url ? `(${url})` : m;
      });
    },
    toJSON: () => urls.length,
  };
}

export const compactItem = (i, links = null) => ({
  id: i.id,
  title: truncate(i.title, 110),
  section: SECTION[i.category],
  score: i.score,
  ...(i.dueAt && { due: i.dueAt.slice(0, 10) }),
  why: i.reasons.slice(0, 2).map((r) => r.label),
  next: truncate(i.nextAction, 150),
  from: [...new Set(i.sources.map((s) => s.system))].join('+'),
  ...(links && i.sources[0]?.url && { link: links.ref(i.sources[0].url) }),
});

export const allItems = (report) => [...report.critical, ...report.waitingOnMe, ...report.releaseRisks, ...report.followUps]
  .sort((a, b) => b.score - a.score);

// Per-project rollup for cross-project risk analysis (computed, not guessed).
export function projectRisks(report) {
  const byProject = new Map();
  for (const i of allItems(report)) {
    const p = i.project ?? 'General';
    const row = byProject.get(p) ?? { project: p, critical: 0, waiting: 0, releaseRisk: 0, followUps: 0, blocked: 0, overdue: 0, totalScore: 0 };
    row[{ critical: 'critical', waiting_on_me: 'waiting', release_risks: 'releaseRisk', follow_ups: 'followUps' }[i.category]]++;
    if (i.reasons.some((r) => /blocked|depends on/i.test(r.label))) row.blocked++;
    if (i.reasons.some((r) => /^Overdue by/.test(r.label))) row.overdue++;
    row.totalScore += i.score;
    byProject.set(p, row);
  }
  return [...byProject.values()].sort((a, b) => b.totalScore - a.totalScore).slice(0, 6);
}

export function releasesAtRisk(store) {
  return store.listItems({ source: 'jira', kind: 'release' })
    .filter((r) => r.data.tracked && r.data.risk !== 'none')
    .map((r) => ({ release: r.title, date: r.data.releaseDate, risk: r.data.risk, reasons: r.data.reasons }));
}

function changesSince(store, since) {
  const events = store.actionEventsSince(since);
  const pick = (re) => events.filter((e) => re.test(e.event)).map((e) => ({ id: e.id, title: truncate(e.title, 100), ...(e.closed_reason && { how: e.closed_reason === 'auto' ? 'resolved (reply or fix detected)' : 'closed by you' }) }));
  return {
    new: pick(/^created$/),
    closed: pick(/^status:(done|dismissed)$/),
    reopened: pick(/^reopened$/),
  };
}

export const hasChanges = (c) => Boolean(c && (c.new.length || c.closed.length || c.reopened.length));

function sourceStatus(store, name, enabled) {
  if (!enabled) return { available: false, reason: `${name} not connected` };
  const s = store.getSyncState(name);
  if (!s?.last_success_at) return { available: false, reason: s?.last_error ? `${name} sync failing: ${truncate(s.last_error, 80)}` : `${name} not synced yet` };
  return { available: true, lastSync: s.last_success_at, ...(s.last_error && { warning: truncate(s.last_error, 80) }) };
}

// ─── Morning briefing (8 sections) ───────────────────────────────────────────
export async function buildMorningContext(store, report, { now = new Date(), timeZone, live = {} } = {}) {
  const links = createLinkTable();
  const items = allItems(report);
  const prev = store.lastBriefingSnapshot('morning');
  const prevScores = prev?.items ?? {};
  const isNewOrChanged = (i) => prevScores[i.id] === undefined || prevScores[i.id] !== i.score;
  const stillImportant = (i) => i.category === 'critical' || i.category === 'waiting_on_me';

  const sources = {
    jira: sourceStatus(store, 'jira', live.jiraEnabled),
    outlook: sourceStatus(store, 'outlook', live.outlookEnabled),
    teams: sourceStatus(store, 'teams', live.teamsEnabled),
  };

  // 2. Meetings
  let meetings;
  if (!live.graph || !live.calendarEnabled) {
    meetings = { available: false, reason: 'Outlook calendar not connected (needs Microsoft sign-in with Calendars.Read)' };
  } else {
    try {
      const waiting = report.waitingOnMe.map((i) => ({ who: i.sources.find((s) => s.system !== 'Jira')?.text.match(/from (.+?) on/)?.[1] ?? null, title: truncate(i.title, 60) }));
      const list = await todaysMeetings(live.graph, { timeZone, now });
      meetings = {
        available: true,
        items: list.map((m) => ({
          time: `${m.start}–${m.end}`, subject: truncate(m.subject, 90), organizer: m.organizer, attendees: m.attendees,
          keyAttendees: m.keyAttendees, purpose: m.purpose ? truncate(m.purpose, 140) : 'not stated in the invite',
          prepare: prepHints(m, { releases: releasesAtRisk(store), waiting }), link: links.ref(m.joinUrl ?? m.url),
        })),
      };
    } catch (err) {
      log.warn('meetings unavailable', { error: err.message });
      meetings = { available: false, reason: `calendar request failed: ${truncate(err.message, 100)}` };
    }
  }

  // 3. Pending actions (waiting on me), 4. Production, 7. Overdue.
  // Items already listed as today's priorities aren't repeated below them.
  const topIds = new Set(items.slice(0, 3).map((i) => i.id));
  const pending = report.waitingOnMe.filter((i) => !topIds.has(i.id) && (isNewOrChanged(i) || stillImportant(i))).slice(0, 8).map((i) => compactItem(i, links));
  const production = items.filter((i) => i.reasons.some((r) => /^Production blocker/.test(r.label))).slice(0, 6)
    .map((i) => ({ ...compactItem(i, links), owner: i.sources.find((s) => s.system === 'Jira')?.text.split(' · ')[3] ?? 'unknown' }));
  // Long-stale items ("Overdue since … probably stale") are cleanup, not today's work.
  const overdueAll = items.filter((i) => !topIds.has(i.id) && i.reasons.some((r) => /^Overdue by|You committed|No reply to your question/.test(r.label)));
  const overdue = overdueAll.filter((i) => isNewOrChanged(i) || i.score >= 40).slice(0, 6).map((i) => compactItem(i, links));

  // 5. Releases with scope changes since the last briefing
  const releaseItems = store.listItems({ source: 'jira', kind: 'release' }).filter((r) => r.data.tracked);
  const releases = releaseItems.map((r) => {
    const before = prev?.releases?.[r.data.id];
    const nowKeys = r.data.issueKeys ?? [];
    return {
      release: r.title, date: r.data.releaseDate, risk: r.data.risk, openIssues: r.data.openIssues,
      blockers: [...(r.data.blockedIssues ?? []), ...(r.data.productionBlockers ?? [])],
      reasons: r.data.reasons ?? [],
      scopeChange: before ? { added: nowKeys.filter((k) => !before.includes(k)), removed: before.filter((k) => !nowKeys.includes(k)) } : 'first report',
      link: links.ref(r.url),
    };
  }).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  // 6. Named scopes (ezCater, …) — live Jira snapshot
  const scopes = {};
  for (const [name, jql] of Object.entries(live.scopes ?? {})) {
    if (!live.jiraClient) {
      scopes[name] = { available: false, reason: 'Jira not configured' };
      continue;
    }
    try {
      const s = await scopeSnapshot(live.jiraClient, name, jql, { now });
      const ref = (x) => ({ ...x, url: undefined, link: links.ref(x.url) });
      scopes[name] = {
        available: true, total: s.total, byStatus: s.byStatus, byType: s.byType, owners: s.owners,
        blocked: s.blocked.map(ref), unassigned: s.unassigned.length, highPriority: s.highPriority.map(ref).slice(0, 5),
        overdue: s.overdue.map(ref).slice(0, 5), changedLast24h: s.changedLast24h.map(ref).slice(0, 5),
      };
    } catch (err) {
      scopes[name] = { available: false, reason: `Jira query failed: ${truncate(err.message, 100)}` };
    }
  }

  const since = store.lastSentBriefing()?.sent_at ?? new Date(now - 86_400_000).toISOString();
  const omitted = report.followUps.filter((i) => !isNewOrChanged(i)).length;

  const context = {
    kind: 'morning',
    today: dayKey(now, timeZone),
    timeZone,
    sources,
    counts: report.counts,
    priorities: items.slice(0, 3).map((i) => compactItem(i, links)),
    meetings,
    pending: { items: pending, missing: Object.entries(sources).filter(([, v]) => !v.available).map(([k, v]) => `${k}: ${v.reason}`) },
    production,
    releases,
    scopes,
    overdue,
    projects: projectRisks(report),
    changesSinceLastBriefing: changesSince(store, since),
    unchangedFollowUpsOmitted: omitted,
  };
  const snapshot = {
    items: Object.fromEntries(items.map((i) => [i.id, i.score])),
    releases: Object.fromEntries(releaseItems.map((r) => [r.data.id, r.data.issueKeys ?? []])),
  };
  return { context, links, snapshot };
}

// ─── Midday / end of day (incremental) ───────────────────────────────────────
export function buildBriefingContext(store, report, kind, { now = new Date(), timeZone } = {}) {
  const items = allItems(report);
  const today = dayKey(now, timeZone);
  const startOfDay = zonedTimeToUtc(now, timeZone, 0, 0).toISOString();
  const counts = report.counts;

  if (kind === 'midday') {
    const since = store.getBriefing('morning', today)?.sent_at ?? startOfDay;
    return {
      kind, today, counts,
      changesSinceMorning: changesSince(store, since),
      topItems: items.slice(0, 5).map((i) => compactItem(i)),
    };
  }

  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000), timeZone);
  return {
    kind, today, counts,
    changesToday: changesSince(store, startOfDay),
    stillOpen: items.filter((i) => ['critical', 'waiting_on_me'].includes(i.category)).slice(0, 8).map((i) => compactItem(i)),
    dueTomorrow: items.filter((i) => i.dueAt?.slice(0, 10) === tomorrow).map((i) => compactItem(i)),
  };
}
