// Feature tracking report: for each initiative in the tracked-feature registry,
// walks Initiative → Epics → Stories/Bugs/other issues through Jira's `parent`
// field (verified on this site; epics can live in other projects, e.g. UP).
// Counts, statuses and dates are facts computed here; health, risks and
// follow-ups are rule-based inferences and labelled as such. Read-only.

import { truncate } from '../text.js';
import { loadBoard, toWorkItem, blockReasons, daysBetween } from './board.js';
import { diffSnapshot } from './snapshot.js';

export const FEATURE_DEFAULTS = Object.freeze({
  dueSoonDays: 14,      // epic due within this many days…
  dueSoonMinPct: 50,    // …and less than this % done → at risk
  staleDays: 14,        // no issue in the feature updated for this long → stale
  devHoursPerDay: 6,    // timeline: focus hours per assigned developer per working day
  qaHoursPerDay: 6,     // …and per assigned QA
  hoursCoverageMin: 70, // % of issues that need hours before progress is weighted by hours
  listLimit: 5,
});

const BASE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'parent', 'issuelinks', 'updated',
  'created', 'resolutiondate', 'duedate', 'fixVersions', 'components', 'labels'];
const BUG_RX = /bug|prod_/i;
const URGENT = new Set(['Highest', 'Blocker', 'Critical', 'High']);
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// Custom field ids by name (they differ per Jira site).
async function fieldIds(client) {
  const all = await client.fields();
  const byName = (re) => all.find((f) => re.test(f.name) && f.custom)?.id ?? null;
  return {
    targetStart: byName(/^target start$/i), targetEnd: byName(/^target end$/i), flagged: byName(/^flagged$/i),
    devHours: byName(/^dev hours$/i), qaHours: byName(/^qa hours$/i),
    assignedDev: byName(/^assigned developer$/i), assignedQa: byName(/^assigned qa$/i),
  };
}

// Where an issue is in the dev → QA flow, from its board column (columns named
// QA/test are the QA stage; columns after them are past QA). Issues in statuses
// that aren't on the board fall back to the status name.
export function stageResolver(board) {
  const cols = board.phases.columns ?? [];
  const qa = cols.map((c, i) => (/qa|test/i.test(c.name) ? i : -1)).filter((i) => i >= 0);
  const [firstQa, lastQa] = qa.length ? [Math.min(...qa), Math.max(...qa)] : [-1, -1];
  return (item) => {
    if (item.phase === 'done') return 'done';
    if (item.phase === 'blocked') return 'blocked'; // dev or QA: decided from the change log
    const idx = cols.findIndex((c) => c.name === item.column);
    if (idx >= 0 && firstQa >= 0) {
      if (idx > lastQa) return 'afterQa';
      if (idx >= firstQa) return 'qa';
    } else if (/qa|test/i.test(item.status ?? '')) return 'qa';
    return item.phase === 'todo' ? 'notStarted' : 'dev';
  };
}
export const devComplete = (stage) => stage === 'qa' || stage === 'afterQa' || stage === 'done';
const QA_STATUS_RX = /qa|test/i;

// Blocked / On Hold: who moved the ticket there decides whether it was blocked
// in dev or in QA. The latest move into the current status is compared with
// the ticket's Assigned Developer / Assigned QA; if it was someone else, the
// status it came from decides. No change-log entry → treated as in dev.
export function blockedStage(item, history) {
  const moves = history.flatMap((h) => (h.items ?? [])
    .filter((x) => x.field === 'status' && (x.to === String(item.statusId ?? '') || x.toString === item.status))
    .map((x) => ({ at: h.created, by: h.author ?? null, from: x.fromString })));
  const last = moves.at(-1);
  if (!last) return { stage: 'blocked', role: 'dev', basis: 'no change-log entry for the move; treated as in dev' };
  const who = last.by?.displayName ?? 'unknown';
  const id = last.by?.accountId;
  if (id && id === item.assignedQaId) return { stage: 'qa', role: 'QA', by: who, at: last.at, basis: `moved to ${item.status} by ${who}, the Assigned QA` };
  if (id && id === item.assignedDevId) return { stage: 'blocked', role: 'dev', by: who, at: last.at, basis: `moved to ${item.status} by ${who}, the Assigned Developer` };
  const fromQa = QA_STATUS_RX.test(last.from ?? '');
  return {
    stage: fromQa ? 'qa' : 'blocked', role: fromQa ? 'QA' : 'dev', by: who, at: last.at,
    basis: `moved to ${item.status} by ${who} from ${last.from ?? 'unknown'}`,
  };
}
export const qaComplete = (stage) => stage === 'afterQa' || stage === 'done';

// Adds n working days (Mon–Fri) to a YYYY-MM-DD date.
export function addWorkingDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

async function searchAll(client, jql, fields, limit = 5000) {
  const { issues, truncated } = await client.search({ jql, fields, limit });
  return { issues, truncated };
}

export async function buildFeatureReport({ client, boardId = null, features, removed = [], now = new Date(), previous = null, rules = {} }) {
  const r = { ...FEATURE_DEFAULTS, ...rules };
  const warnings = [];
  const ids = await fieldIds(client);
  const fields = [...BASE_FIELDS, ...Object.values(ids).filter(Boolean)];
  if (!ids.devHours || !ids.qaHours) warnings.push('DEV Hours / QA Hours fields not found in Jira; dev/QA progress uses issue counts and no timeline is estimated');
  // Board column mapping when a board is configured; otherwise Jira status categories.
  const board = boardId ? await loadBoard(client, boardId) : fallbackBoard();
  const stageOf = stageResolver(board);
  const work = (raw) => {
    const item = toWorkItem(raw, { client, board });
    const f = raw.fields ?? {};
    item.flagged = ids.flagged ? Array.isArray(f[ids.flagged]) && f[ids.flagged].length > 0 : false;
    item.statusCategory = f.status?.statusCategory?.key ?? null;
    item.due = f.duedate ?? null;
    item.targetStart = ids.targetStart ? f[ids.targetStart] ?? null : null;
    item.targetEnd = ids.targetEnd ? f[ids.targetEnd] ?? null : null;
    item.parent = f.parent?.key ?? null;
    item.level = f.issuetype?.hierarchyLevel ?? null;
    item.stage = stageOf(item);
    item.resolved = f.resolutiondate ?? null;
    const hrs = (id) => (id && typeof f[id] === 'number' && f[id] > 0 ? f[id] : null);
    item.devHrs = hrs(ids.devHours);
    item.qaHrs = hrs(ids.qaHours);
    item.assignedDev = ids.assignedDev ? f[ids.assignedDev]?.displayName ?? null : null;
    item.assignedQa = ids.assignedQa ? f[ids.assignedQa]?.displayName ?? null : null;
    item.assignedDevId = ids.assignedDev ? f[ids.assignedDev]?.accountId ?? null : null;
    item.assignedQaId = ids.assignedQa ? f[ids.assignedQa]?.accountId ?? null : null;
    item.statusId = f.status?.id ?? null;
    return item;
  };

  const keys = features.map((f) => f.key);
  const out = { report: 'features', asOf: now.toISOString(), comparedWith: previous?.takenAt ?? null, features: [], warnings, rules: r };
  if (!keys.length) {
    warnings.push('No features are tracked. Add one with: npm run features -- add <KEY>');
    return finish(out, previous, removed);
  }

  // Three levels in as few calls as possible: initiatives, their children (epics), their children.
  const top = (await searchAll(client, `key in (${keys.join(',')})`, fields)).issues.map(work);
  const missing = keys.filter((k) => !top.some((t) => t.key === k));
  for (const k of missing) warnings.push(`${k} was not found in Jira (deleted, moved or no permission)`);

  const level1 = [];
  for (const part of chunks(top.map((t) => t.key), 50)) {
    const res = await searchAll(client, `parent in (${part.join(',')})`, fields);
    if (res.truncated) warnings.push('Epic list truncated');
    level1.push(...res.issues.map(work));
  }
  const epics = level1.filter((i) => i.level === 1 || /epic/i.test(i.type ?? ''));
  const level2 = [];
  for (const part of chunks(epics.map((e) => e.key), 50)) {
    const res = await searchAll(client, `parent in (${part.join(',')}) AND issuetype not in subTaskIssueTypes()`, fields);
    if (res.truncated) warnings.push('Child issue list truncated; counts may be low');
    level2.push(...res.issues.map(work));
  }

  // Blocked / On Hold tickets: read their change log (only these) to see
  // whether dev or QA put them there.
  const blocked = [...level1, ...level2].filter((i) => i.stage === 'blocked' && !(i.level >= 1));
  for (let i = 0; i < blocked.length; i += 5) {
    await Promise.all(blocked.slice(i, i + 5).map(async (item) => {
      try {
        item.blockedIn = blockedStage(item, client.changelog ? await client.changelog(item.key) : []);
      } catch (err) {
        item.blockedIn = { stage: 'blocked', role: 'dev', basis: `change log unavailable (${err.message}); treated as in dev` };
      }
      item.stage = item.blockedIn.stage;
    }));
  }

  for (const f of features) {
    const init = top.find((t) => t.key === f.key);
    if (!init) continue;
    const myEpics = epics.filter((e) => e.parent === init.key);
    const direct = level1.filter((i) => i.parent === init.key && !myEpics.includes(i)); // non-epic children
    const children = level2.filter((i) => myEpics.some((e) => e.key === i.parent));
    out.features.push(featureSection(init, f, myEpics, [...children, ...direct], { now, rules: r, previous: previous?.features?.[init.key] ?? null }));
  }
  return finish(out, previous, removed);
}

function fallbackBoard() {
  const phase = { new: 'todo', indeterminate: 'inProgress', done: 'done' };
  return {
    pointsField: null,
    phases: {
      phaseOf: (status) => ({
        phase: /block|hold/i.test(status?.name ?? '') && status?.statusCategory?.key !== 'done' ? 'blocked' : phase[status?.statusCategory?.key] ?? 'todo',
        column: status?.name ?? 'unknown',
      }),
    },
  };
}

function featureSection(init, reg, epics, issues, { now, rules, previous }) {
  const today = now.toISOString().slice(0, 10);
  const open = issues.filter((i) => i.phase !== 'done');
  const done = issues.length - open.length;
  const allKeys = new Set([init.key, ...epics.map((e) => e.key), ...issues.map((i) => i.key)]);

  const epicRows = epics.map((e) => {
    const kids = issues.filter((i) => i.parent === e.key);
    const kOpen = kids.filter((i) => i.phase !== 'done');
    const due = e.targetEnd ?? e.due;
    const daysLeft = due ? daysBetween(`${today}T00:00:00Z`, `${due.slice(0, 10)}T00:00:00Z`) : null;
    const flags = [];
    if (!kids.length && e.phase !== 'done') flags.push('no child issues (not broken down)');
    if (e.statusCategory === 'done' && kOpen.length) flags.push(`epic is ${e.status} but ${kOpen.length} child issue(s) open`);
    if (due && daysLeft < 0 && kOpen.length) flags.push(`due ${due.slice(0, 10)} passed ${-daysLeft} day(s) ago with ${kOpen.length} open`);
    if (due && daysLeft >= 0 && daysLeft <= rules.dueSoonDays && pct(kids.length - kOpen.length, kids.length) < rules.dueSoonMinPct) {
      flags.push(`due in ${daysLeft} day(s) at ${pct(kids.length - kOpen.length, kids.length)}% done`);
    }
    return {
      key: e.key, summary: truncate(e.summary, 80), status: e.status, done: e.statusCategory === 'done', owner: e.owner, url: e.url,
      due, daysLeft, total: kids.length, open: kOpen.length, donePct: pct(kids.length - kOpen.length, kids.length),
      blocked: kOpen.filter((i) => blockReasons(i).length).length,
      openBugs: kOpen.filter((i) => BUG_RX.test(i.type ?? '')).length,
      flags,
    };
  }).sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));

  const blockers = open.map((i) => ({ ...brief(i), why: blockReasons(i), blockedIn: i.blockedIn ?? null })).filter((b) => b.why.length);
  const bugs = open.filter((i) => BUG_RX.test(i.type ?? ''));
  const criticalBugs = bugs.filter((i) => URGENT.has(i.priority)).map(brief);
  const dependencies = open
    .map((i) => ({ ...brief(i), waitsOn: i.deps.filter((d) => !d.done && !allKeys.has(d.key)) }))
    .filter((i) => i.waitsOn.length);
  const releases = {};
  for (const i of open) for (const v of i.fixVersions.filter((x) => !x.released)) {
    releases[v.name] ??= { name: v.name, releaseDate: v.releaseDate, open: 0 };
    releases[v.name].open++;
  }
  const lastUpdate = [init, ...epics, ...issues].map((i) => i.updated).filter(Boolean).sort().at(-1) ?? null;
  const idleDays = lastUpdate ? daysBetween(lastUpdate, now.toISOString()) : null;
  const unowned = open.filter((i) => !i.owner);
  const flow = devQaProgress(issues, { today, rules });
  const dates = {
    initiative: init.targetEnd ?? init.due ?? null,
    initiativeStart: init.targetStart ?? null,
    latestEpicDue: epicRows.map((e) => e.due).filter(Boolean).sort().at(-1) ?? null,
    epicsWithDate: epicRows.filter((e) => e.due).length,
  };

  // ─── Inferred (rule-based) ────────────────────────────────────────────────
  const risks = [];
  const overdue = epicRows.filter((e) => e.flags.some((x) => x.startsWith('due ') && x.includes('passed')));
  const dueSoon = epicRows.filter((e) => e.flags.some((x) => x.startsWith('due in')));
  if (overdue.length) risks.push(`${overdue.length} epic(s) past their due date with open work`);
  if (dueSoon.length) risks.push(`${dueSoon.length} epic(s) due within ${rules.dueSoonDays} days and under ${rules.dueSoonMinPct}% done`);
  if (blockers.length) risks.push(`${blockers.length} blocked issue(s)`);
  if (criticalBugs.length) risks.push(`${criticalBugs.length} open high-priority bug(s)`);
  if (dependencies.length) risks.push(`${dependencies.length} issue(s) waiting on work outside this feature`);
  if (!dates.initiative && !dates.epicsWithDate) risks.push('no target dates on the initiative or its epics');
  const notBrokenDown = epicRows.filter((e) => e.flags.some((x) => x.startsWith('no child')));
  if (notBrokenDown.length) risks.push(`${notBrokenDown.length} epic(s) with no child issues`);
  const inconsistent = epicRows.filter((e) => e.flags.some((x) => x.startsWith('epic is')));
  if (inconsistent.length) risks.push(`${inconsistent.length} closed epic(s) still have open children`);
  if (unowned.length) risks.push(`${unowned.length} open issue(s) without an owner`);
  if (idleDays != null && idleDays >= rules.staleDays && open.length) risks.push(`no activity in ${idleDays} days`);

  const health = overdue.length ? 'off track'
    : dueSoon.length || blockers.length || criticalBugs.length ? 'at risk'
      : open.length || !issues.length ? 'on track' : 'complete';
  const healthWhy = overdue.length ? 'epics past due with open work'
    : dueSoon.length ? 'epics due soon with low progress'
      : blockers.length || criticalBugs.length ? 'blocked work or high-priority bugs'
        : !dates.initiative && !dates.epicsWithDate ? 'nothing overdue or blocked, but there are no target dates to measure against'
          : 'nothing overdue, blocked or critical';

  const snapshot = {
    epics: Object.fromEntries(epics.map((e) => [e.key, e.status])),
    issues: Object.fromEntries(issues.map((i) => [i.key, [i.phase, null, i.owner]])),
  };
  let changes = null;
  if (previous) {
    const d = diffSnapshot(previous.issues, snapshot.issues);
    const epicMoves = Object.entries(snapshot.epics)
      .filter(([k, s]) => previous.epics?.[k] && previous.epics[k] !== s)
      .map(([k, s]) => ({ key: k, from: previous.epics[k], to: s }));
    changes = {
      ...d,
      epicsAdded: Object.keys(snapshot.epics).filter((k) => !previous.epics?.[k]),
      epicsRemoved: Object.keys(previous.epics ?? {}).filter((k) => !(k in snapshot.epics)),
      epicStatus: epicMoves,
      donePctBefore: previous.donePct ?? null,
      devPctBefore: previous.devPct ?? null,
      qaPctBefore: previous.qaPct ?? null,
    };
  }

  const section = {
    key: init.key, summary: init.summary, type: init.type, level: init.level, status: init.status, owner: init.owner, url: init.url,
    note: reg.note ?? null, trackedSince: reg.added_at ?? null,
    dates,
    totals: {
      epics: epics.length, epicsDone: epicRows.filter((e) => e.done).length,
      issues: issues.length, done, open: open.length, donePct: pct(done, issues.length),
      openBugs: bugs.length, criticalBugs: criticalBugs.length, blocked: blockers.length, unowned: unowned.length,
    },
    dev: flow.dev,
    qa: flow.qa,
    people: flow.people,
    timeline: flow.timeline,
    epics: epicRows,
    blockers, criticalBugs, dependencies,
    releases: Object.values(releases).sort((a, b) => b.open - a.open),
    lastUpdate, idleDays,
    health: { status: health, reason: healthWhy, inferred: true },
    risks,
    changes,
    snapshot: { ...snapshot, donePct: pct(done, issues.length), devPct: flow.dev.pct, qaPct: flow.qa.pct },
  };
  section.followUps = featureFollowUps(section);
  return section;
}

function brief(i) {
  return { key: i.key, summary: truncate(i.summary, 90), status: i.status, owner: i.owner, priority: i.priority, type: i.type, parent: i.parent, url: i.url };
}

// Dev and QA progress weighted by DEV Hours / QA Hours (by issue count when no
// hours are set), remaining hours per Assigned Developer / Assigned QA, and a
// rough finish estimate. Facts: the sums. Inference: the timeline.
export function devQaProgress(issues, { today, rules }) {
  const measure = (hrsKey, isComplete) => {
    const total = issues.length;
    const doneN = issues.filter((i) => isComplete(i.stage)).length;
    const withHrs = issues.filter((i) => i[hrsKey]);
    const totalHrs = withHrs.reduce((n, i) => n + i[hrsKey], 0);
    const doneHrs = withHrs.filter((i) => isComplete(i.stage)).reduce((n, i) => n + i[hrsKey], 0);
    const remaining = issues.filter((i) => !isComplete(i.stage));
    // Hours only weight progress when most issues have them; otherwise a few
    // estimated tickets would stand for the whole initiative.
    const byHours = totalHrs > 0 && pct(withHrs.length, total) >= rules.hoursCoverageMin;
    return {
      basis: byHours ? 'hours' : 'issues',
      pct: byHours ? pct(doneHrs, totalHrs) : pct(doneN, total),
      hoursPct: totalHrs ? pct(doneHrs, totalHrs) : null,
      issuesComplete: doneN, issues: total,
      hours: { total: round(totalHrs), done: round(doneHrs), remaining: round(totalHrs - doneHrs), onIssues: withHrs.length },
      remainingWithoutHours: remaining.filter((i) => !i[hrsKey]).length,
    };
  };
  const dev = measure('devHrs', devComplete);
  const qa = measure('qaHrs', qaComplete);

  const load = (personKey, hrsKey, isComplete) => {
    const m = new Map();
    for (const i of issues.filter((x) => !isComplete(x.stage))) {
      const who = i[personKey] ?? null;
      const e = m.get(who) ?? { name: who, hours: 0, issues: 0, hoursWaitingOnDev: 0 };
      e.hours += i[hrsKey] ?? 0;
      e.issues++;
      if (hrsKey === 'qaHrs' && !devComplete(i.stage)) e.hoursWaitingOnDev += i.qaHrs ?? 0;
      m.set(who, e);
    }
    return [...m.values()].map((e) => ({ ...e, hours: round(e.hours), hoursWaitingOnDev: round(e.hoursWaitingOnDev) }))
      .sort((a, b) => (a.name === null) - (b.name === null) || b.hours - a.hours);
  };
  const devPeople = load('assignedDev', 'devHrs', devComplete);
  const qaPeople = load('assignedQa', 'qaHrs', qaComplete);

  // Timeline: each named person works through their own remaining hours at
  // N hours a day; QA of items still in dev can only finish after dev does.
  const named = (xs) => xs.filter((p) => p.name);
  const devDays = Math.max(0, ...named(devPeople).map((p) => p.hours / rules.devHoursPerDay));
  const qaDays = Math.max(0, ...named(qaPeople).map((p) => p.hours / rules.qaHoursPerDay));
  const qaTail = Math.max(0, ...named(qaPeople).map((p) => p.hoursWaitingOnDev / rules.qaHoursPerDay));
  const days = Math.ceil(Math.max(devDays + qaTail, qaDays));
  const busiest = [...named(devPeople).map((p) => ({ ...p, days: p.hours / rules.devHoursPerDay, role: 'dev' })),
    ...named(qaPeople).map((p) => ({ ...p, days: p.hours / rules.qaHoursPerDay, role: 'QA' }))].sort((a, b) => b.days - a.days)[0] ?? null;
  const unassignedDevHrs = devPeople.find((p) => !p.name)?.hours ?? 0;
  const unassignedQaHrs = qaPeople.find((p) => !p.name)?.hours ?? 0;
  const anyRemaining = dev.hours.remaining + qa.hours.remaining > 0;
  const timeline = !anyRemaining && (dev.remainingWithoutHours || qa.remainingWithoutHours)
    ? { estimate: null, reason: 'open issues have no DEV/QA Hours, so no estimate', inferred: true }
    : {
      estimate: anyRemaining ? { workingDays: days, finish: addWorkingDays(today, days), devDays: round(devDays), qaDays: round(qaDays), qaAfterDevDays: round(qaTail) } : null,
      reason: anyRemaining ? null : 'no remaining dev or QA hours',
      busiest: busiest ? { name: busiest.name, role: busiest.role, hours: busiest.hours, days: round(busiest.days) } : null,
      assumes: `${rules.devHoursPerDay} h/day per developer and ${rules.qaHoursPerDay} h/day per QA, all on this initiative`,
      excludes: {
        unassignedDevHours: unassignedDevHrs, unassignedQaHours: unassignedQaHrs,
        openWithoutDevHours: dev.remainingWithoutHours, openWithoutQaHours: qa.remainingWithoutHours,
      },
      inferred: true,
    };
  return { dev, qa, people: { dev: devPeople, qa: qaPeople }, timeline };
}

const round = (n) => Math.round(n * 10) / 10;

export function featureFollowUps(f) {
  const out = [];
  const tag = (text, rule, keys = []) => out.push({ rule, keys: [f.key, ...keys], text: `${f.key}: ${text}` });
  const overdue = f.epics.filter((x) => x.flags.some((y) => y.includes('passed')));
  if (overdue.length === 1) tag(`re-plan ${overdue[0].key} (${overdue[0].owner ?? 'no owner'}) — ${overdue[0].flags.find((y) => y.includes('passed'))}`, 'epic-overdue', [overdue[0].key]);
  if (overdue.length > 1) {
    const open = overdue.reduce((n, e) => n + e.open, 0);
    tag(`re-plan ${overdue.length} epics past their due date (${open} open issues; earliest due ${overdue.map((e) => e.due.slice(0, 10)).sort()[0]}): ${overdue.map((e) => `${e.key} (${e.open})`).join(', ')}`, 'epic-overdue', overdue.map((e) => e.key));
  }
  for (const e of f.epics.filter((x) => x.flags.some((y) => y.startsWith('due in')))) tag(`check ${e.key} can land — ${e.flags.find((y) => y.startsWith('due in'))}`, 'epic-due-soon', [e.key]);
  for (const b of f.blockers.slice(0, 3)) tag(`unblock ${b.key} (${b.owner ?? 'no owner'}): ${b.why.join('; ')}`, 'blocker', [b.key]);
  if (f.blockers.length > 3) tag(`${f.blockers.length - 3} more blocked issue(s): ${f.blockers.slice(3, 8).map((b) => b.key).join(', ')}`, 'blocker');
  for (const b of f.criticalBugs.slice(0, 3)) tag(`track ${b.priority} bug ${b.key} (${b.owner ?? 'no owner'}, ${b.status})`, 'critical-bug', [b.key]);
  for (const d of f.dependencies.slice(0, 3)) tag(`${d.key} waits on ${d.waitsOn.map((w) => `${w.key} (${w.status})`).join(', ')} outside this feature — confirm timing`, 'dependency', [d.key]);
  if (!f.dates.initiative && !f.dates.epicsWithDate && f.totals.open) tag('set target dates on the initiative or its epics so progress can be measured', 'no-dates');
  for (const e of f.epics.filter((x) => x.flags.some((y) => y.startsWith('epic is')))) tag(`reconcile ${e.key} — ${e.flags.find((y) => y.startsWith('epic is'))}`, 'epic-inconsistent', [e.key]);
  const empty = f.epics.filter((x) => x.flags.some((y) => y.startsWith('no child')));
  if (empty.length) tag(`break down or close ${empty.length} epic(s) with no issues: ${empty.map((e) => e.key).join(', ')}`, 'epic-empty');
  if (f.totals.unowned) tag(`assign owners to ${f.totals.unowned} open issue(s)`, 'no-owner');
  return out;
}

function finish(out, previous, removed) {
  const now = new Set(out.features.map((f) => f.key));
  const before = new Set(Object.keys(previous?.features ?? {}));
  out.tracking = {
    added: [...now].filter((k) => previous && !before.has(k)),
    removed: [...before].filter((k) => !now.has(k)),
    previouslyTracked: removed.map((r) => ({ key: r.key, summary: r.summary, removedAt: r.removed_at })),
  };
  out.followUps = out.features.flatMap((f) => f.followUps);
  return out;
}

// ─── Rendering (Teams-card-friendly markdown; no tables) ──────────────────────
const link = (i) => `[${i.key}](${i.url})`;
const HEALTH_ICON = { 'off track': '🔴', 'at risk': '🟠', 'on track': '🟢', complete: '✅' };

export function renderFeatureReport(rep) {
  const lines = [`**🧭 Feature report** (as of ${rep.asOf.slice(0, 16).replace('T', ' ')} UTC)`];
  if (rep.comparedWith) lines.push(`Changes are compared with the report from ${rep.comparedWith.slice(0, 10)}.`);
  for (const w of rep.warnings) lines.push(`- ⚠️ ${w}`);
  const t = rep.tracking;
  if (t.added.length) lines.push(`- Added to tracking since last report: ${t.added.join(', ')}`);
  if (t.removed.length) lines.push(`- Removed from tracking since last report: ${t.removed.join(', ')}`);

  lines.push('', '**Overall** (health is inferred; counts are from Jira)');
  for (const f of rep.features) {
    const est = f.timeline.estimate ? ` · est. finish ~${f.timeline.estimate.finish}` : '';
    lines.push(`- ${HEALTH_ICON[f.health.status] ?? '⚪'} ${link(f)} ${f.summary} — **${f.health.status}** — dev ${f.dev.pct}% · QA ${f.qa.pct}%${est} — ${f.totals.done}/${f.totals.issues} issues done, ${f.totals.epicsDone}/${f.totals.epics} epics closed`);
  }

  const n = rep.rules.listLimit;
  for (const f of rep.features) {
    lines.push('', `**${f.key} — ${f.summary}**`);
    lines.push('', '**Facts (from Jira)**');
    lines.push(`- ${f.type}, status ${f.status}, owner ${f.owner ?? 'none'}${f.note ? ` — note: ${f.note}` : ''}`);
    lines.push(`- ${f.totals.issues} issues under ${f.totals.epics} epics: ${f.totals.done} done, ${f.totals.open} open (${f.totals.donePct}% done) · open bugs ${f.totals.openBugs} (${f.totals.criticalBugs} high priority) · blocked ${f.totals.blocked} · unowned ${f.totals.unowned}`);
    const dateBits = [
      f.dates.initiative && `initiative ${f.dates.initiative.slice(0, 10)}`,
      f.dates.epicsWithDate && `${f.dates.epicsWithDate}/${f.totals.epics} epics dated, latest ${f.dates.latestEpicDue.slice(0, 10)}`,
    ].filter(Boolean);
    lines.push(`- Target dates: ${dateBits.length ? dateBits.join('; ') : 'none set on the initiative or epics'}`);
    if (f.releases.length) lines.push(`- Open work by release: ${f.releases.slice(0, 6).map((r) => `${r.name} (${r.open})`).join(', ')}${f.releases.length > 6 ? ` +${f.releases.length - 6} more` : ''}`);
    lines.push(`- Last activity: ${f.lastUpdate ? `${f.lastUpdate.slice(0, 10)} (${f.idleDays} day(s) ago)` : 'unknown'}`);

    const prog = (label, p, h) => {
      const state = label === 'Dev' ? 'dev-complete' : 'QA-complete';
      const hours = p.hours.total ? `${p.hours.done}/${p.hours.total} ${h} h done, ${p.hours.remaining} h left; hours on ${p.hours.onIssues}/${p.issues} issues` : 'no hours set';
      return p.basis === 'hours'
        ? `- ${label} progress: **${p.pct}%** by ${h} hours (${hours}) · ${p.issuesComplete}/${p.issues} issues ${state}`
        : `- ${label} progress: **${p.pct}%** by issues (${p.issuesComplete}/${p.issues} ${state}) · ${hours}${p.hours.total ? ` — too few to weight by hours (${p.hoursPct}% by hours)` : ''}`;
    };
    lines.push('', '**Dev and QA progress** (from Jira; not dev-complete = Open … Building; QA in progress = Ready for QA / QA in Progress; QA done = anything later)');
    lines.push(prog('Dev', f.dev, 'DEV'), prog('QA', f.qa, 'QA'));
    const ppl = (xs, unit) => xs.slice(0, 6).map((p) => `${p.name ?? 'not assigned'} ${p.hours} h (${p.issues})`).join(', ') + (xs.length > 6 ? ` +${xs.length - 6} more` : '');
    const inDev = f.blockers.filter((b) => b.blockedIn?.role === 'dev').length;
    const inQa = f.blockers.filter((b) => b.blockedIn?.role === 'QA').length;
    if (inDev + inQa) lines.push(`- Blocked / On Hold: ${inDev} in dev (not dev-complete), ${inQa} in QA (dev-complete) — from who moved them there in the change log`);
    if (f.people.dev.length) lines.push(`- Assigned developers, remaining dev hours (FYI): ${ppl(f.people.dev)}`);
    if (f.people.qa.length) lines.push(`- Assigned QA, remaining QA hours (FYI): ${ppl(f.people.qa)}`);

    lines.push('', '**Epics**');
    if (!f.epics.length) lines.push('- No epics under this issue');
    for (const e of f.epics) {
      lines.push(`- ${link(e)} ${e.summary} — ${e.status} — ${e.total - e.open}/${e.total} done (${e.donePct}%)${e.due ? ` — due ${e.due.slice(0, 10)}` : ''}${e.blocked ? ` — ${e.blocked} blocked` : ''}${e.openBugs ? ` — ${e.openBugs} open bug(s)` : ''}${e.flags.length ? ` — ⚠️ ${e.flags.join('; ')}` : ''}`);
    }
    if (f.criticalBugs.length) {
      lines.push('', `**High-priority bugs** (${f.criticalBugs.length})`);
      for (const b of f.criticalBugs.slice(0, n)) lines.push(`- ${link(b)} ${b.summary} — ${b.priority} — ${b.status} — ${b.owner ?? 'no owner'}`);
      if (f.criticalBugs.length > n) lines.push(`- …and ${f.criticalBugs.length - n} more`);
    }
    if (f.blockers.length) {
      lines.push('', `**Blocked** (${f.blockers.length})`);
      for (const b of f.blockers.slice(0, n)) lines.push(`- ${link(b)} ${b.summary} — ${b.owner ?? 'no owner'} — ${b.why.join('; ')}${b.blockedIn ? ` — blocked in ${b.blockedIn.role} (${b.blockedIn.basis})` : ''}`);
      if (f.blockers.length > n) lines.push(`- …and ${f.blockers.length - n} more`);
    }
    if (f.dependencies.length) {
      lines.push('', `**Dependencies outside this feature** (${f.dependencies.length})`);
      for (const d of f.dependencies.slice(0, n)) lines.push(`- ${link(d)} waits on ${d.waitsOn.map((w) => `${w.key} (${w.kind}, ${w.status})`).join(', ')}`);
    }
    if (f.changes) {
      const c = f.changes;
      const bits = [
        c.newlyDone.length && `done: ${c.newlyDone.join(', ')}`,
        c.newlyBlocked.length && `newly blocked: ${c.newlyBlocked.join(', ')}`,
        c.added.length && `new issues: ${c.added.join(', ')}`,
        c.removed.length && `issues removed: ${c.removed.join(', ')}`,
        c.epicsAdded.length && `new epics: ${c.epicsAdded.join(', ')}`,
        c.epicStatus.length && `epic status: ${c.epicStatus.map((m) => `${m.key} ${m.from} → ${m.to}`).join('; ')}`,
        c.donePctBefore != null && c.donePctBefore !== f.totals.donePct && `progress ${c.donePctBefore}% → ${f.totals.donePct}%`,
        c.devPctBefore != null && c.devPctBefore !== f.dev.pct && `dev ${c.devPctBefore}% → ${f.dev.pct}%`,
        c.qaPctBefore != null && c.qaPctBefore !== f.qa.pct && `QA ${c.qaPctBefore}% → ${f.qa.pct}%`,
      ].filter(Boolean);
      lines.push('', '**Since last report**', bits.length ? bits.map((b) => `- ${b}`).join('\n') : '- No changes');
    }
    lines.push('', '**⚠️ Inferred (rules, not Jira facts)**');
    lines.push(`- Health: **${f.health.status}** — ${f.health.reason}`);
    const tl = f.timeline;
    if (tl.estimate) {
      const x = tl.excludes;
      const left = [x.unassignedDevHours && `${x.unassignedDevHours} dev h with no assigned developer`, x.unassignedQaHours && `${x.unassignedQaHours} QA h with no assigned QA`,
        x.openWithoutDevHours && `${x.openWithoutDevHours} open issue(s) without DEV Hours`, x.openWithoutQaHours && `${x.openWithoutQaHours} open issue(s) without QA Hours`].filter(Boolean);
      lines.push(`- Estimated finish: **~${tl.estimate.finish}** (${tl.estimate.workingDays} working days: dev ~${tl.estimate.devDays} d, QA of items still in dev ~${tl.estimate.qaAfterDevDays} d after that, QA backlog ~${tl.estimate.qaDays} d)${tl.busiest ? `; busiest: ${tl.busiest.name} (${tl.busiest.role}, ${tl.busiest.hours} h)` : ''}`);
      lines.push(`  - Assumes ${tl.assumes}${left.length ? `; leaves out ${left.join(', ')}, so it is optimistic` : ''}`);
    } else {
      lines.push(`- Estimated finish: not estimated — ${tl.reason}`);
    }
    for (const r of f.risks) lines.push(`- Risk: ${r}`);
  }

  if (t.previouslyTracked.length) {
    lines.push('', `**No longer tracked** (history kept): ${t.previouslyTracked.map((p) => `${p.key} (removed ${p.removedAt.slice(0, 10)})`).join(', ')}`);
  }
  lines.push('', `**➡️ Recommended follow-ups**${rep.followUpsSource === 'claude' ? ' (prioritised by Claude from the facts above)' : ' (rule-based)'}`);
  if (!rep.followUps.length) lines.push('- Nothing needs your attention');
  for (const f of rep.followUps) lines.push(`- ${f.text}`);
  return lines.join('\n');
}
