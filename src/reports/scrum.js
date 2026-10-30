// Scrum sprint report: a daily snapshot of every active sprint on one board.
// All counts, phases and lists are computed here from Jira data (facts).
// Health, at-risk items and follow-ups are rule-based inferences and are
// labelled as such. Nothing here writes to Jira.

import { normalizeIssue } from '../jira/normalize.js';
import { truncate } from '../text.js';
import { boardPhases, dependencies, daysBetween, PHASES, PHASE_LABEL } from './board.js';
import { diffSnapshot } from './snapshot.js';

const BASE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'components', 'fixVersions',
  'issuelinks', 'updated', 'created', 'resolutiondate', 'flagged', 'closedSprints', 'labels'];

export const SCRUM_DEFAULTS = Object.freeze({
  staleDays: 3,          // in progress / review with no update for this many days → at risk
  carryoverSprints: 3,   // carried over this many sprints or more → "chronic"
  notStartedTimePct: 50, // still "to do" after this share of the sprint → at risk
  // Health compares share of work done with share of time gone (percentage points).
  healthAtRiskGap: 15,
  healthOffTrackGap: 30,
  healthMinTimePct: 20,  // before this, it's too early to call
  listLimit: 15,
});

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const PRIORITY_RANK = { Highest: 0, Blocker: 0, Critical: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };

// sprintPrefix limits the report to sprints whose name starts with it (e.g.
// "Restaurant"); an explicit sprintFilter (id or part of a name) overrides it.
export async function buildScrumReport({ client, boardId, now = new Date(), previous = null, sprintFilter = null, sprintPrefix = '', rules = {} }) {
  const r = { ...SCRUM_DEFAULTS, ...rules };
  const [config, statuses, sprintList] = await Promise.all([
    client.boardConfiguration(boardId),
    client.statuses(),
    client.boardSprints(boardId, 'active'),
  ]);
  const phases = boardPhases(config, statuses);
  const pointsField = config.estimation?.field?.fieldId ?? null;
  const fields = pointsField ? [...BASE_FIELDS, pointsField] : BASE_FIELDS;

  let sprints = sprintList.items;
  let wanted = 'The board has no active sprint';
  if (sprintFilter) {
    const f = String(sprintFilter).toLowerCase();
    sprints = sprints.filter((s) => String(s.id) === f || s.name.toLowerCase().includes(f));
    wanted = `No active sprint matches "${sprintFilter}"`;
  } else if (sprintPrefix) {
    const p = sprintPrefix.toLowerCase();
    sprints = sprints.filter((s) => s.name.toLowerCase().startsWith(p));
    wanted = `No active sprint name starts with "${sprintPrefix}" (active: ${sprintList.items.map((s) => s.name).join(', ') || 'none'})`;
  }

  const warnings = [];
  if (!sprints.length) warnings.push(wanted);
  if (!pointsField) warnings.push('The board has no story point field; progress is by issue count only');

  const out = [];
  for (const s of sprints) {
    const { items, truncated } = await client.sprintIssues(boardId, s.id, fields);
    if (truncated) warnings.push(`${s.name}: issue list truncated; counts may be low`);
    out.push(sprintSection(s, items, { client, phases, pointsField, now, rules: r, previous: previous?.sprints?.[s.id] ?? null }));
  }

  return {
    report: 'scrum',
    boardId: Number(boardId),
    boardName: config.name ?? `Board ${boardId}`,
    asOf: now.toISOString(),
    pointsField,
    columns: phases.columns.map((c) => ({ name: c.name, phase: c.phase })),
    comparedWith: previous?.takenAt ?? null,
    sprints: out,
    warnings,
    rules: r,
  };
}

function sprintSection(sprint, raw, { client, phases, pointsField, now, rules, previous }) {
  const issues = raw.map((ri) => {
    const n = normalizeIssue(ri);
    const f = ri.fields ?? {};
    const { phase, column } = phases.phaseOf(f.status);
    return {
      key: n.key,
      summary: n.summary,
      type: n.type,
      status: n.status,
      column,
      phase,
      priority: n.priority,
      owner: n.assignee?.name ?? null,
      points: pointsField && typeof f[pointsField] === 'number' ? f[pointsField] : null,
      components: (f.components ?? []).map((c) => c.name),
      fixVersions: n.fixVersions.map((v) => v.name),
      flagged: f.flagged === true,
      carriedOver: (f.closedSprints ?? []).length,
      updated: f.updated ?? null,
      deps: dependencies(ri),
      url: client.browseUrl(n.key),
    };
  });

  // ─── Facts ────────────────────────────────────────────────────────────────
  const start = sprint.startDate ?? sprint.activatedDate ?? null;
  const end = sprint.endDate ?? null;
  const daysTotal = start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000)) : null;
  const daysElapsed = start ? Math.max(0, Math.min(daysTotal ?? Infinity, daysBetween(start, now.toISOString()))) : null;
  const timePct = daysTotal ? pct(daysElapsed, daysTotal) : null;

  const byPhase = Object.fromEntries(PHASES.map((p) => {
    const xs = issues.filter((i) => i.phase === p);
    return [p, { issues: xs.length, points: sum(xs.map((i) => i.points ?? 0)) }];
  }));
  const totalPoints = sum(issues.map((i) => i.points ?? 0));
  const unestimated = issues.filter((i) => i.points == null && i.phase !== 'done').length;

  const componentNames = [...new Set(issues.flatMap((i) => (i.components.length ? i.components : ['(no component)'])))];
  const components = componentNames.map((name) => {
    const xs = issues.filter((i) => (i.components.length ? i.components.includes(name) : name === '(no component)'));
    const count = (p) => xs.filter((i) => i.phase === p).length;
    const done = count('done');
    const pts = sum(xs.map((i) => i.points ?? 0));
    const donePts = sum(xs.filter((i) => i.phase === 'done').map((i) => i.points ?? 0));
    return {
      name, issues: xs.length, done, inProgress: count('inProgress') + count('review'), todo: count('todo'), blocked: count('blocked'),
      points: pts, donePoints: donePts, donePct: pts ? pct(donePts, pts) : pct(done, xs.length),
    };
  }).sort((a, b) => b.issues - a.issues);

  const open = issues.filter((i) => i.phase !== 'done');
  const openDeps = (i) => i.deps.filter((d) => !d.done);
  const blockers = open
    .filter((i) => i.phase === 'blocked' || i.flagged || openDeps(i).some((d) => d.kind === 'blocked by'))
    .map((i) => ({
      ...brief(i),
      why: [
        i.phase === 'blocked' && `status ${i.status}`,
        i.flagged && 'flagged as impediment',
        ...openDeps(i).filter((d) => d.kind === 'blocked by').map((d) => `blocked by ${d.key} (${d.status})`),
      ].filter(Boolean),
    }));
  const dependencyList = open
    .filter((i) => openDeps(i).length)
    .map((i) => ({ ...brief(i), waitsOn: openDeps(i).map((d) => ({ key: d.key, kind: d.kind, status: d.status, url: client.browseUrl(d.key) })) }));

  // ─── Inferred (rule-based) ────────────────────────────────────────────────
  const blockerKeys = new Set(blockers.map((b) => b.key));
  const atRisk = open
    .filter((i) => !blockerKeys.has(i.key))
    .map((i) => {
      const reasons = [];
      if (i.phase === 'todo' && timePct != null && timePct >= rules.notStartedTimePct) reasons.push(`not started with ${timePct}% of the sprint gone`);
      const idle = i.updated ? daysBetween(i.updated, now.toISOString()) : null;
      if ((i.phase === 'inProgress' || i.phase === 'review') && idle != null && idle >= rules.staleDays) reasons.push(`no update in ${idle} days`);
      if (!i.owner) reasons.push('no owner');
      if (i.carriedOver >= rules.carryoverSprints) reasons.push(`carried over ${i.carriedOver} sprints`);
      for (const d of openDeps(i).filter((x) => x.kind === 'depends on')) reasons.push(`depends on ${d.key} (${d.status})`);
      return { ...brief(i), reasons };
    })
    .filter((i) => i.reasons.length)
    .sort((a, b) => b.reasons.length - a.reasons.length || (PRIORITY_RANK[a.priority] ?? 5) - (PRIORITY_RANK[b.priority] ?? 5));

  const doneBasis = totalPoints ? 'points' : 'issues';
  const donePct = { issues: pct(byPhase.done.issues, issues.length), points: pct(byPhase.done.points, totalPoints) };
  const health = sprintHealth({ timePct, donePct: donePct[doneBasis], basis: doneBasis, blocked: byPhase.blocked.issues, total: issues.length, rules });

  const carriedOver = issues.filter((i) => i.carriedOver > 0 && i.phase !== 'done');
  const chronic = carriedOver.filter((i) => i.carriedOver >= rules.carryoverSprints).sort((a, b) => b.carriedOver - a.carriedOver);

  const section = {
    id: sprint.id,
    name: sprint.name,
    goal: sprint.goal || null,
    start, end, daysTotal, daysElapsed, timePct,
    daysLeft: daysTotal != null ? Math.max(0, daysTotal - daysElapsed) : null,
    totals: { issues: issues.length, points: totalPoints, unestimated, withoutComponent: issues.filter((i) => !i.components.length).length },
    byPhase,
    donePct,
    health,
    components,
    completed: issues.filter((i) => i.phase === 'done').map(brief),
    inProgress: issues.filter((i) => i.phase === 'inProgress' || i.phase === 'review').map(brief),
    remaining: issues.filter((i) => i.phase === 'todo' || i.phase === 'blocked').map(brief),
    blockers,
    dependencies: dependencyList,
    atRisk,
    carryover: { open: carriedOver.length, chronic: chronic.map((i) => ({ ...brief(i), sprints: i.carriedOver })) },
    snapshot: Object.fromEntries(issues.map((i) => [i.key, [i.phase, i.points, i.owner]])),
  };
  section.changes = previous ? diffSnapshot(previous.issues, section.snapshot) : null;
  section.followUps = ruleFollowUps(section, rules);
  return section;
}

function brief(i) {
  return {
    key: i.key, summary: truncate(i.summary, 90), status: i.status, phase: i.phase, owner: i.owner,
    priority: i.priority, points: i.points, components: i.components, url: i.url,
  };
}

// Explainable health call: share of work done vs share of time gone.
export function sprintHealth({ timePct, donePct, basis, blocked, total, rules }) {
  if (timePct == null) return { status: 'unknown', reason: 'sprint has no start/end date', inferred: true };
  const blockedPct = pct(blocked, total);
  if (timePct < rules.healthMinTimePct) {
    return { status: 'too early', reason: `${timePct}% of the sprint gone; ${donePct}% of ${basis} done, ${blocked} blocked`, inferred: true };
  }
  const gap = timePct - donePct;
  let status = gap >= rules.healthOffTrackGap ? 'off track' : gap >= rules.healthAtRiskGap ? 'at risk' : 'on track';
  if (status === 'on track' && blockedPct >= 15) status = 'at risk';
  return {
    status,
    reason: `${donePct}% of ${basis} done with ${timePct}% of the sprint gone (gap ${gap} pts)${blocked ? `; ${blocked} blocked (${blockedPct}%)` : ''}`,
    inferred: true,
  };
}

// Deterministic follow-ups; each says which rule produced it.
export function ruleFollowUps(s, rules) {
  const out = [];
  const keys = (xs, n = 5) => xs.slice(0, n).map((i) => i.key).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '');
  for (const b of s.blockers.slice(0, 5)) {
    out.push({ rule: 'blocker', keys: [b.key], text: `Unblock ${b.key} (${b.owner ?? 'no owner'}): ${b.why.join('; ')}` });
  }
  const unowned = [...s.remaining, ...s.inProgress].filter((i) => !i.owner);
  if (unowned.length) out.push({ rule: 'no-owner', keys: unowned.map((i) => i.key), text: `Assign owners to ${unowned.length} issue(s): ${keys(unowned)}` });
  const notStarted = s.atRisk.filter((i) => i.reasons.some((r) => r.startsWith('not started')));
  if (notStarted.length) out.push({ rule: 'not-started', keys: notStarted.map((i) => i.key), text: `Confirm ${notStarted.length} not-started issue(s) can still finish by ${s.end?.slice(0, 10)}: ${keys(notStarted)}` });
  const stale = s.atRisk.filter((i) => i.reasons.some((r) => r.startsWith('no update')));
  if (stale.length) out.push({ rule: 'stale', keys: stale.map((i) => i.key), text: `Check in on ${stale.length} issue(s) with no update in ${rules.staleDays}+ days: ${keys(stale)}` });
  if (s.carryover.chronic.length) {
    out.push({ rule: 'chronic-carryover', keys: s.carryover.chronic.map((i) => i.key), text: `Decide on ${s.carryover.chronic.length} issue(s) carried over ${rules.carryoverSprints}+ sprints (finish, split or move to backlog): ${keys(s.carryover.chronic)}` });
  }
  const deps = s.dependencies.filter((d) => d.waitsOn.some((w) => w.kind === 'depends on'));
  if (deps.length) out.push({ rule: 'dependency', keys: deps.map((d) => d.key), text: `Confirm ${deps.length} open dependenc${deps.length === 1 ? 'y' : 'ies'} will land in time: ${keys(deps)}` });
  if (s.totals.issues && s.totals.withoutComponent / s.totals.issues >= 0.25) {
    out.push({ rule: 'no-component', keys: [], text: `${s.totals.withoutComponent} of ${s.totals.issues} issues have no component, so progress by workstream is incomplete` });
  }
  if (s.totals.unestimated) out.push({ rule: 'unestimated', keys: [], text: `${s.totals.unestimated} open issue(s) have no story points` });
  return out;
}

// ─── Rendering (Teams-card-friendly markdown: bold, bullets, links; no tables) ─
const link = (i) => `[${i.key}](${i.url})`;
const owner = (i) => i.owner ?? 'no owner';
const more = (xs, n) => (xs.length > n ? [`- …and ${xs.length - n} more`] : []);

export function renderScrumReport(rep) {
  const lines = [`**🏃 Scrum report — ${rep.boardName}** (as of ${rep.asOf.slice(0, 16).replace('T', ' ')} UTC)`];
  if (rep.comparedWith) lines.push(`Changes are compared with the report from ${rep.comparedWith.slice(0, 10)}.`);
  for (const w of rep.warnings) lines.push(`- ⚠️ ${w}`);

  for (const s of rep.sprints) {
    const n = rep.rules.listLimit;
    lines.push('', `**${s.name}** — ${s.start?.slice(0, 10)} → ${s.end?.slice(0, 10)}, day ${s.daysElapsed} of ${s.daysTotal} (${s.daysLeft} left)`);
    if (s.goal) lines.push(`Goal: ${s.goal}`);

    lines.push('', '**Facts (from Jira)**');
    const pts = rep.pointsField ? ` / ${s.totals.points} pts` : '';
    lines.push(`- ${s.totals.issues} issues${pts}: ${PHASES.map((p) => `${PHASE_LABEL[p]} ${s.byPhase[p].issues}`).join(' · ')}`);
    lines.push(`- Done: ${s.donePct.issues}% of issues${rep.pointsField ? `, ${s.donePct.points}% of points` : ''}`);
    if (s.carryover.open) lines.push(`- Carried over from earlier sprints (open): ${s.carryover.open}`);
    if (s.totals.unestimated) lines.push(`- Open issues without story points: ${s.totals.unestimated}`);

    lines.push('', '**By component**');
    for (const c of s.components) {
      lines.push(`- ${c.name}: ${c.done}/${c.issues} done (${c.donePct}%${rep.pointsField && c.points ? ` of ${c.points} pts` : ''}) · in progress ${c.inProgress} · to do ${c.todo}${c.blocked ? ` · blocked ${c.blocked}` : ''}`);
    }

    if (s.changes) {
      const ch = s.changes;
      lines.push('', '**Since last report**');
      if (!ch.newlyDone.length && !ch.newlyBlocked.length && !ch.added.length && !ch.removed.length && !ch.moved.length) lines.push('- No changes');
      if (ch.newlyDone.length) lines.push(`- Done: ${ch.newlyDone.join(', ')}`);
      if (ch.newlyBlocked.length) lines.push(`- Newly blocked: ${ch.newlyBlocked.join(', ')}`);
      if (ch.moved.length) lines.push(`- Moved: ${ch.moved.slice(0, 10).map((m) => `${m.key} ${PHASE_LABEL[m.from]} → ${PHASE_LABEL[m.to]}`).join('; ')}${ch.moved.length > 10 ? ` +${ch.moved.length - 10} more` : ''}`);
      if (ch.added.length) lines.push(`- Added to sprint: ${ch.added.join(', ')}`);
      if (ch.removed.length) lines.push(`- Removed from sprint: ${ch.removed.join(', ')}`);
    }

    lines.push('', `**Blockers and impediments** (${s.blockers.length})`);
    if (!s.blockers.length) lines.push('- None in Jira');
    for (const b of s.blockers.slice(0, n)) lines.push(`- ${link(b)} ${b.summary} — ${owner(b)} — ${b.why.join('; ')}`);
    lines.push(...more(s.blockers, n));

    const extDeps = s.dependencies.filter((d) => d.waitsOn.some((w) => w.kind === 'depends on'));
    if (extDeps.length) {
      lines.push('', `**Dependencies** (${extDeps.length})`);
      for (const d of extDeps.slice(0, n)) lines.push(`- ${link(d)} waits on ${d.waitsOn.map((w) => `[${w.key}](${w.url}) (${w.status})`).join(', ')}`);
      lines.push(...more(extDeps, n));
    }

    lines.push('', `**In progress** (${s.inProgress.length})`);
    for (const i of s.inProgress.slice(0, n)) lines.push(`- ${link(i)} ${i.summary} — ${i.status} — ${owner(i)}`);
    lines.push(...more(s.inProgress, n));
    lines.push('', `**Remaining (not started)** (${s.remaining.filter((i) => i.phase === 'todo').length})`);
    const todo = s.remaining.filter((i) => i.phase === 'todo');
    for (const i of todo.slice(0, n)) lines.push(`- ${link(i)} ${i.summary} — ${owner(i)}`);
    lines.push(...more(todo, n));
    lines.push('', `**Completed** (${s.completed.length})`);
    for (const i of s.completed.slice(0, n)) lines.push(`- ${link(i)} ${i.summary}`);
    lines.push(...more(s.completed, n));

    lines.push('', '**⚠️ Inferred (rules, not Jira facts)**');
    lines.push(`- Health: **${s.health.status}** — ${s.health.reason}`);
    lines.push(`- At-risk issues: ${s.atRisk.length}`);
    for (const i of s.atRisk.slice(0, 10)) lines.push(`  - ${link(i)} ${i.summary} — ${i.reasons.join('; ')}`);
    if (s.atRisk.length > 10) lines.push(`  - …and ${s.atRisk.length - 10} more`);

    lines.push('', `**➡️ Recommended follow-ups**${s.followUpsSource === 'claude' ? ' (prioritised by Claude from the facts above)' : ' (rule-based)'}`);
    if (!s.followUps.length) lines.push('- Nothing needs your attention');
    for (const f of s.followUps) lines.push(`- ${f.text}`);
  }
  return lines.join('\n');
}
