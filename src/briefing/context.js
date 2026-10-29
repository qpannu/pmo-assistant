// Compact, incremental inputs for briefings: only what Claude needs to write
// them (ranked items, reasons, next steps, what changed) — no raw emails.

import { truncate } from '../text.js';
import { localToday } from '../jira/classify.js';

const SECTION = { critical: 'critical', waiting_on_me: 'waiting', release_risks: 'release', follow_ups: 'follow-up' };

export const compactItem = (i) => ({
  id: i.id,
  title: truncate(i.title, 110),
  section: SECTION[i.category],
  score: i.score,
  ...(i.dueAt && { due: i.dueAt.slice(0, 10) }),
  why: i.reasons.slice(0, 2).map((r) => r.label),
  next: truncate(i.nextAction, 150),
  from: [...new Set(i.sources.map((s) => s.system))].join('+'),
});

const allItems = (report) => [...report.critical, ...report.waitingOnMe, ...report.releaseRisks, ...report.followUps]
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

const startOfDay = (now) => new Date(`${localToday(now)}T00:00:00`).toISOString();

export function buildBriefingContext(store, report, kind, now = new Date()) {
  const items = allItems(report);
  const today = localToday(now);
  const counts = report.counts;

  if (kind === 'morning') {
    const since = store.lastSentBriefing()?.sent_at ?? new Date(now - 86_400_000).toISOString();
    return {
      kind, today, counts,
      topItems: items.slice(0, 12).map(compactItem),
      projects: projectRisks(report),
      releases: releasesAtRisk(store),
      changesSinceLastBriefing: changesSince(store, since),
    };
  }

  if (kind === 'midday') {
    const since = store.getBriefing('morning', today)?.sent_at ?? startOfDay(now);
    return {
      kind, today, counts,
      changesSinceMorning: changesSince(store, since),
      topItems: items.slice(0, 5).map(compactItem),
    };
  }

  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return {
    kind, today, counts,
    changesToday: changesSince(store, startOfDay(now)),
    stillOpen: items.filter((i) => ['critical', 'waiting_on_me'].includes(i.category)).slice(0, 8).map(compactItem),
    dueTomorrow: items.filter((i) => i.dueAt?.slice(0, 10) === tomorrow).map(compactItem),
  };
}

export const hasChanges = (c) => Boolean(c && (c.new.length || c.closed.length || c.reopened.length));
