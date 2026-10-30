// Release report: unreleased Fix Versions that hold the board's work (the
// board filter, so only the team's issues count). Release readiness is kept
// apart from sprint progress: a release counts every issue tagged with it,
// whichever sprint (if any) it sits in. Facts are computed here; readiness,
// risks and follow-ups are rule-based inferences and labelled as such.
// Nothing here writes to Jira.

import { followUpLine, learningLines } from './learning.js';
import { truncate } from '../text.js';
import { loadBoard, toWorkItem, blockReasons, daysBetween, PHASES, PHASE_LABEL } from './board.js';
import { diffSnapshot } from './snapshot.js';

export const RELEASE_DEFAULTS = Object.freeze({
  dueSoonDays: 14,   // target date within this many days → "approaching"
  activeDays: 30,    // open work but no issue updated for this long → "dormant"
  listLimit: 5,
});

const BUG_RX = /bug|prod_/i;
const URGENT = new Set(['Highest', 'Blocker', 'Critical', 'High']);
const BUCKET_RX = /\.x$/i; // "POS_7.46.0.X" style placeholders, not a real build
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Product line from the version name: "POS_7.46.0.6" → "POS", "OLO 2.1.X" → "OLO".
export function productLine(name) {
  const m = String(name).match(/^([A-Za-z][A-Za-z ]*?)[_ ]?\d/);
  return (m ? m[1] : String(name).split(/[_ ]/)[0]).trim() || 'Other';
}

// prefixes limits the report to versions whose name starts with one of them
// (case-insensitive), e.g. ['POS_7', 'MPOS_', 'KIOSK_', 'CCL_8.']; empty = all.
export async function buildReleaseReport({ client, boardId, now = new Date(), previous = null, versionFilter = null, prefixes = [], rules = {} }) {
  const r = { ...RELEASE_DEFAULTS, ...rules };
  const board = await loadBoard(client, boardId);
  const scopeJql = 'fixVersion in unreleasedVersions()';
  const { items, truncated } = await client.boardIssues(boardId, scopeJql, board.fields);
  const today = now.toISOString().slice(0, 10);
  const warnings = truncated ? ['Issue list truncated; release counts may be low'] : [];

  // The board API leaves out issues whose status has no board column (e.g.
  // "Discovery"), but they are still release work: fetch them by the board's
  // filter and count them in their status category.
  if (board.filterId && client.search) {
    const { issues: keys } = await client.search({ jql: `filter = ${board.filterId} AND ${scopeJql}`, fields: ['status'], limit: 5000 });
    const seen = new Set(items.map((i) => i.key));
    const missing = keys.map((i) => i.key).filter((k) => !seen.has(k));
    if (missing.length) {
      const { issues: extra } = await client.search({ jql: `key in (${missing.join(',')})`, fields: board.fields, limit: missing.length });
      items.push(...extra);
      const statuses = [...new Set(extra.map((i) => i.fields?.status?.name))].join(', ');
      warnings.push(`${extra.length} issue(s) in a status with no board column (${statuses}) are included, counted by status category`);
    }
  }

  // Group by version name: projects on the board (e.g. REST and UP) can each
  // have a version with the same name, and to a PM that is one release.
  const tracked = (name) => !prefixes.length || prefixes.some((p) => name.toLowerCase().startsWith(p.toLowerCase()));
  const byVersion = new Map();
  const untracked = new Set();
  let multiVersion = 0;
  for (const raw of items) {
    const item = toWorkItem(raw, { client, board });
    const unreleased = [...new Set(item.fixVersions.filter((v) => !v.released).map((v) => v.name))];
    for (const n of unreleased) if (!tracked(n)) untracked.add(n);
    const names = unreleased.filter(tracked);
    if (names.length > 1) multiVersion++;
    for (const v of item.fixVersions.filter((x) => !x.released && names.includes(x.name))) {
      const entry = byVersion.get(v.name) ?? { name: v.name, ids: [], releaseDate: null, issues: [] };
      if (!entry.ids.includes(v.id)) entry.ids.push(v.id);
      entry.releaseDate ??= v.releaseDate;
      if (!entry.issues.some((i) => i.key === item.key)) entry.issues.push(item);
      byVersion.set(v.name, entry);
    }
  }

  let releases = [...byVersion.values()].map((v) => releaseSection(v, { now, today, rules: r, previous: previous?.versions?.[v.name] ?? null }));
  if (versionFilter) {
    const f = String(versionFilter).toLowerCase();
    releases = releases.filter((x) => x.name.toLowerCase().includes(f));
    if (!releases.length) warnings.push(`No unreleased version with board work matches "${versionFilter}"`);
  }

  const active = releases.filter((x) => x.state === 'active').sort(releaseOrder);
  const dormant = releases.filter((x) => x.state === 'dormant').sort((a, b) => b.open - a.open);
  const complete = releases.filter((x) => x.state === 'complete').sort((a, b) => a.name.localeCompare(b.name));

  const report = {
    report: 'releases',
    boardId: Number(boardId),
    boardName: board.name,
    asOf: now.toISOString(),
    comparedWith: previous?.takenAt ?? null,
    prefixes: [...prefixes],
    untrackedVersions: untracked.size,
    totals: {
      versions: releases.length, active: active.length, dormant: dormant.length, complete: complete.length,
      issues: items.length, inMoreThanOneVersion: multiVersion,
      approaching: active.filter((x) => x.dateStatus === 'due soon').length,
      datePassed: active.filter((x) => x.dateStatus === 'date passed').length,
      noDate: active.filter((x) => x.dateStatus === 'no date').length,
    },
    active, dormant, complete,
    warnings,
    rules: r,
  };
  report.followUps = ruleFollowUps(report);
  return report;
}

// Overdue first, then nearest date, then undated by open work.
function releaseOrder(a, b) {
  const rank = { 'date passed': 0, 'due soon': 1, scheduled: 2, 'no date': 3 };
  return (rank[a.dateStatus] - rank[b.dateStatus])
    || (a.releaseDate && b.releaseDate ? a.releaseDate.localeCompare(b.releaseDate) : 0)
    || b.open - a.open;
}

function releaseSection(v, { now, today, rules, previous }) {
  const issues = v.issues;
  const open = issues.filter((i) => i.phase !== 'done');
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, issues.filter((i) => i.phase === p).length]));
  const lastUpdate = issues.map((i) => i.updated).filter(Boolean).sort().at(-1) ?? null;
  const idleDays = lastUpdate ? daysBetween(lastUpdate, now.toISOString()) : null;

  const daysToTarget = v.releaseDate ? daysBetween(`${today}T00:00:00Z`, `${v.releaseDate}T00:00:00Z`) : null;
  const dateStatus = !v.releaseDate ? 'no date'
    : daysToTarget < 0 ? 'date passed'
      : daysToTarget <= rules.dueSoonDays ? 'due soon' : 'scheduled';

  const state = !open.length ? 'complete' : idleDays != null && idleDays >= rules.activeDays ? 'dormant' : 'active';

  const components = [...new Set(issues.flatMap((i) => (i.components.length ? i.components : ['(no component)'])))]
    .map((name) => {
      const xs = issues.filter((i) => (i.components.length ? i.components.includes(name) : name === '(no component)'));
      return { name, issues: xs.length, done: xs.filter((i) => i.phase === 'done').length };
    })
    .sort((a, b) => b.issues - a.issues);

  const blocked = open.map((i) => ({ ...brief(i), why: blockReasons(i) })).filter((b) => b.why.length);
  const bugs = open.filter((i) => BUG_RX.test(i.type ?? '')).map(brief);
  const urgentBugs = bugs.filter((b) => URGENT.has(b.priority));
  const notInActiveSprint = open.filter((i) => i.sprint?.state !== 'active');
  const unowned = open.filter((i) => !i.owner);
  const notStarted = open.filter((i) => i.phase === 'todo');

  // ─── Inferred (rule-based) readiness and risks ───────────────────────────
  const risks = [];
  if (dateStatus === 'date passed') risks.push(`target date ${v.releaseDate} passed ${-daysToTarget} day(s) ago with ${open.length} open`);
  if (dateStatus === 'due soon' && notStarted.length) risks.push(`due in ${daysToTarget} day(s) and ${notStarted.length} issue(s) not started`);
  if (dateStatus === 'no date') risks.push('no target date in Jira');
  if (blocked.length) risks.push(`${blocked.length} blocked`);
  if (urgentBugs.length) risks.push(`${urgentBugs.length} open high-priority bug(s)`);
  if (notInActiveSprint.length) risks.push(`${notInActiveSprint.length} open issue(s) not in an active sprint`);
  if (unowned.length) risks.push(`${unowned.length} open issue(s) without an owner`);
  if (BUCKET_RX.test(v.name)) risks.push('placeholder version (".x"), not a specific build');

  let readiness;
  if (!open.length) readiness = 'all work done';
  else if (blocked.length) readiness = 'blocked';
  else if (open.every((i) => i.phase === 'review')) readiness = 'in final review / QA';
  else if (dateStatus === 'date passed' || (dateStatus === 'due soon' && notStarted.length)) readiness = 'at risk';
  else readiness = 'in progress';

  const section = {
    name: v.name,
    versionIds: v.ids,
    productLine: productLine(v.name),
    bucket: BUCKET_RX.test(v.name),
    releaseDate: v.releaseDate,
    daysToTarget,
    dateStatus,
    state,
    lastUpdate,
    idleDays,
    total: issues.length,
    open: open.length,
    done: byPhase.done,
    donePct: pct(byPhase.done, issues.length),
    byPhase,
    components,
    blocked,
    bugs,
    urgentBugs,
    notInActiveSprint: notInActiveSprint.length,
    unowned: unowned.map(brief),
    readiness: { status: readiness, inferred: true },
    risks,
    snapshot: Object.fromEntries(issues.map((i) => [i.key, [i.phase, i.points, i.owner]])),
  };
  section.changes = previous ? { ...diffSnapshot(previous.issues, section.snapshot), dateMoved: previous.releaseDate !== v.releaseDate ? { from: previous.releaseDate, to: v.releaseDate } : null } : null;
  return section;
}

function brief(i) {
  return {
    key: i.key, summary: truncate(i.summary, 90), status: i.status, phase: i.phase, owner: i.owner,
    priority: i.priority, type: i.type, inActiveSprint: i.sprint?.state === 'active', url: i.url,
  };
}

// Deterministic actions and decisions; each names the rule that produced it.
export function ruleFollowUps(rep) {
  const out = [];
  const names = (xs, n = 6) => xs.slice(0, n).map((x) => x.name).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '');
  for (const x of rep.active.filter((a) => a.dateStatus === 'date passed')) {
    out.push({ rule: 'date-passed', keys: [], text: `Decide on ${x.name}: target ${x.releaseDate} passed ${-x.daysToTarget} day(s) ago with ${x.open} open — set a new date or descope` });
  }
  for (const x of rep.active.filter((a) => a.dateStatus === 'due soon' && a.readiness.status !== 'in final review / QA')) {
    out.push({ rule: 'due-soon', keys: [], text: `${x.name} is due ${x.releaseDate} (${x.daysToTarget} day(s)) with ${x.open} open (${x.byPhase.todo} not started) — confirm go/no-go` });
  }
  // One line per blocker / urgent bug, naming every active release it holds up.
  const once = (pick) => {
    const seen = new Map();
    for (const x of rep.active) for (const b of pick(x)) seen.set(b.key, { ...b, releases: [...(seen.get(b.key)?.releases ?? []), x.name] });
    // Work in the active sprint first, then issues holding up more releases.
    return [...seen.values()].sort((a, b) => Number(b.inActiveSprint) - Number(a.inActiveSprint) || b.releases.length - a.releases.length);
  };
  const blockers = once((x) => x.blocked);
  for (const b of blockers.slice(0, 8)) out.push({ rule: 'blocker', keys: [b.key], text: `Unblock ${b.key} (${b.owner ?? 'no owner'}) — holds up ${b.releases.join(', ')}: ${b.why.join('; ')}` });
  if (blockers.length > 8) out.push({ rule: 'blocker', keys: blockers.slice(8).map((b) => b.key), text: `${blockers.length - 8} more blocked release issue(s): ${blockers.slice(8, 14).map((b) => b.key).join(', ')}${blockers.length > 14 ? ' …' : ''}` });
  for (const b of once((x) => x.urgentBugs).slice(0, 5)) out.push({ rule: 'urgent-bug', keys: [b.key], text: `Track ${b.priority} bug ${b.key} (${b.owner ?? 'no owner'}, ${b.status}) — in ${b.releases.join(', ')}` });
  const undated = rep.active.filter((a) => a.dateStatus === 'no date' && !a.bucket);
  if (undated.length) out.push({ rule: 'no-date', keys: [], text: `Set target dates for ${undated.length} active release(s) with no date: ${names(undated)}` });
  const buckets = rep.active.filter((a) => a.bucket);
  if (buckets.length) out.push({ rule: 'bucket', keys: [], text: `Move work from placeholder versions into specific builds: ${buckets.map((b) => `${b.name} (${b.open} open)`).join(', ')}` });
  const unscheduled = rep.active.filter((a) => a.notInActiveSprint).sort((a, b) => b.notInActiveSprint - a.notInActiveSprint);
  if (unscheduled.length) out.push({ rule: 'unscheduled', keys: [], text: `Schedule or descope open release work not in an active sprint: ${unscheduled.slice(0, 5).map((a) => `${a.name} (${a.notInActiveSprint})`).join(', ')}${unscheduled.length > 5 ? ` +${unscheduled.length - 5} more` : ''}` });
  if (rep.complete.length) out.push({ rule: 'complete-unreleased', keys: [], text: `${rep.complete.length} version(s) have all board work done but aren't marked released — release or archive them in Jira: ${names(rep.complete)}` });
  if (rep.dormant.length) out.push({ rule: 'dormant', keys: [], text: `${rep.dormant.length} version(s) have open work but no activity in ${rep.rules.activeDays}+ days — close out or archive: ${names(rep.dormant)}` });
  if (rep.totals.inMoreThanOneVersion) out.push({ rule: 'multi-version', keys: [], text: `${rep.totals.inMoreThanOneVersion} issue(s) are tagged with more than one unreleased version — confirm which release each ships in` });
  return out;
}

// ─── Rendering (Teams-card-friendly markdown; no tables) ──────────────────────
const link = (i) => `[${i.key}](${i.url})`;
const dateText = (x) => ({
  'no date': 'no target date',
  'date passed': `target ${x.releaseDate} — passed ${-x.daysToTarget} day(s) ago`,
  'due soon': `target ${x.releaseDate} — in ${x.daysToTarget} day(s)`,
  scheduled: `target ${x.releaseDate} — in ${x.daysToTarget} day(s)`,
}[x.dateStatus]);

export function renderReleaseReport(rep) {
  const t = rep.totals;
  const n = rep.rules.listLimit;
  const lines = [`**🚀 Release report — ${rep.boardName}** (as of ${rep.asOf.slice(0, 16).replace('T', ' ')} UTC)`];
  lines.push('Releases = unreleased Fix Versions holding this board\'s issues. Sprint progress is in the Scrum report.');
  if (rep.comparedWith) lines.push(`Changes are compared with the report from ${rep.comparedWith.slice(0, 10)}.`);
  for (const w of rep.warnings) lines.push(`- ⚠️ ${w}`);

  if (rep.prefixes.length) lines.push(`Tracking versions starting with ${rep.prefixes.join(', ')}${rep.untrackedVersions ? ` (${rep.untrackedVersions} other unreleased version(s) with board work not shown)` : ''}.`);
  lines.push('', '**Facts (from Jira)**');
  lines.push(`- ${t.versions} unreleased versions with board work: ${t.active} active · ${t.dormant} dormant (no activity ${rep.rules.activeDays}+ days) · ${t.complete} with all work done`);
  lines.push(`- Active: ${t.datePassed} past target date · ${t.approaching} due within ${rep.rules.dueSoonDays} days · ${t.noDate} with no target date`);

  const lines4 = new Map();
  for (const x of rep.active) lines4.set(x.productLine, [...(lines4.get(x.productLine) ?? []), x]);
  for (const [line, xs] of lines4) {
    lines.push('', `**${line}**`);
    for (const x of xs) {
      lines.push(`- **${x.name}** — ${dateText(x)} — ${x.done}/${x.total} done (${x.donePct}%) · ${PHASES.filter((p) => p !== 'done' && x.byPhase[p]).map((p) => `${PHASE_LABEL[p]} ${x.byPhase[p]}`).join(' · ') || 'nothing open'}`);
      const comps = x.components.slice(0, 4).map((c) => `${c.name} ${c.done}/${c.issues}`).join(', ');
      lines.push(`  - Components: ${comps}${x.components.length > 4 ? ` +${x.components.length - 4} more` : ''}`);
      if (x.bugs.length) lines.push(`  - Open bugs: ${x.bugs.length}${x.urgentBugs.length ? ` (${x.urgentBugs.length} high priority: ${x.urgentBugs.slice(0, n).map(link).join(', ')})` : ''}`);
      for (const b of x.blocked.slice(0, n)) lines.push(`  - Blocked: ${link(b)} ${b.summary} — ${b.owner ?? 'no owner'} — ${b.why.join('; ')}`);
      if (x.blocked.length > n) lines.push(`  - …and ${x.blocked.length - n} more blocked`);
      if (x.changes) {
        const c = x.changes;
        const bits = [
          c.newlyDone.length && `done ${c.newlyDone.join(', ')}`,
          c.newlyBlocked.length && `newly blocked ${c.newlyBlocked.join(', ')}`,
          c.added.length && `added ${c.added.join(', ')}`,
          c.removed.length && `removed ${c.removed.join(', ')}`,
          c.dateMoved && `target date ${c.dateMoved.from ?? 'none'} → ${c.dateMoved.to ?? 'none'}`,
        ].filter(Boolean);
        lines.push(`  - Since last report: ${bits.length ? bits.join('; ') : 'no changes'}`);
      }
      lines.push(`  - ⚠️ Inferred: **${x.readiness.status}**${x.risks.length ? ` — ${x.risks.join('; ')}` : ''}`);
    }
  }

  if (rep.complete.length) {
    lines.push('', `**All board work done, not marked released** (${rep.complete.length})`);
    lines.push(`- ${rep.complete.map((x) => `${x.name} (${x.total})`).join(', ')}`);
  }
  if (rep.dormant.length) {
    lines.push('', `**Dormant — open work, no activity in ${rep.rules.activeDays}+ days** (${rep.dormant.length})`);
    lines.push(`- ${rep.dormant.map((x) => `${x.name} (${x.open} open, idle ${x.idleDays}d)`).join(', ')}`);
  }

  lines.push('', `**➡️ Recommended actions and decisions**${rep.followUpsSource === 'claude' ? ' (prioritised by Claude from the facts above)' : ' (rule-based)'}`);
  if (!rep.followUps.length) lines.push('- Nothing needs your attention');
  for (const f of rep.followUps) lines.push(followUpLine(f));
  lines.push(...learningLines(rep.learning, { recurring: rep.recurring ?? [], days: rep.recurrenceDays }));
  return lines.join('\n');
}
