// Production issues report: open production problems for one team, found by
// project + issue type + the team dropdown field (verified on this site: the
// "Team[Dropdown]" select field, not the Atlassian Team field). Every issue's
// team value is re-checked, so other teams' problems in the same project never
// count. Facts are computed here; risks and follow-ups are rule-based
// inferences and labelled as such. Read-only.

import { followUpLine, learningLines } from './learning.js';
import { truncate } from '../text.js';
import { loadBoard, toWorkItem, blockReasons, daysBetween } from './board.js';

export const PROD_DEFAULTS = Object.freeze({
  staleDays: 14,        // with engineering and no update this long → stalled
  waitingDays: 30,      // waiting on someone outside engineering this long → chase or close
  resolvedDays: 7,      // "recently resolved" window
  newDays: 7,           // "new" window
  ownerShare: 25,       // one person holding this % of engineering-active issues → concentration
  listLimit: 10,
});

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];
const URGENT_PRIORITY = new Set(['Highest', 'Blocker', 'Critical', 'High']);
const AGE_BUCKETS = [[7, '0–7 days'], [30, '8–30 days'], [90, '31–90 days'], [Infinity, 'over 90 days']];
const BASE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'components', 'fixVersions',
  'issuelinks', 'updated', 'created', 'resolutiondate', 'resolution', 'labels', 'statuscategorychangedate'];

const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const count = (xs, key) => xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});

async function prodFields(client) {
  const all = await client.fields();
  const team = all.find((f) => /^team$/i.test(f.name) && f.schema?.type === 'option')
    ?? all.find((f) => (f.clauseNames ?? []).some((c) => /^team\[dropdown\]$/i.test(c)));
  return {
    team: team?.id ?? null,
    severity: all.find((f) => /^severity$/i.test(f.name) && f.custom)?.id ?? null,
    flagged: all.find((f) => /^flagged$/i.test(f.name) && f.custom)?.id ?? null,
  };
}

export function prodJql({ project, issueType, team }, teamFieldId) {
  const cf = `cf[${teamFieldId.replace('customfield_', '')}]`;
  return `project = ${quote(project)} AND issuetype = ${quote(issueType)} AND ${cf} = ${quote(team)}`;
}

export async function buildProdReport({ client, boardId = null, scope, now = new Date(), previous = null, rules = {} }) {
  const r = { ...PROD_DEFAULTS, ...rules };
  const warnings = [];
  const ids = await prodFields(client);
  if (!ids.team) throw new Error('No "Team" dropdown field found in Jira, so production issues cannot be limited to a team');
  if (!ids.severity) warnings.push('No "Severity" field found; critical/high uses priority only');
  const base = prodJql(scope, ids.team);
  const fields = [...BASE_FIELDS, ...Object.values(ids).filter(Boolean)];
  const board = boardId ? await loadBoard(client, boardId) : null;
  const waiting = new Set((scope.waitingStatuses ?? []).map((s) => s.toLowerCase()));

  const toItem = (raw) => {
    const f = raw.fields ?? {};
    const item = board ? toWorkItem(raw, { client, board }) : toWorkItem(raw, { client, board: fallbackBoard() });
    item.team = f[ids.team]?.value ?? null;
    item.severity = ids.severity ? f[ids.severity]?.value ?? null : null;
    item.flagged = ids.flagged ? Array.isArray(f[ids.flagged]) && f[ids.flagged].length > 0 : false;
    item.created = f.created ?? null;
    item.resolved = f.resolutiondate ?? f.statuscategorychangedate ?? null;
    item.resolution = f.resolution?.name ?? null;
    item.waiting = waiting.has(String(item.status).toLowerCase());
    item.ageDays = item.created ? daysBetween(item.created, now.toISOString()) : null;
    item.idleDays = item.updated ? daysBetween(item.updated, now.toISOString()) : null;
    item.urgent = ['Critical', 'High'].includes(item.severity) || URGENT_PRIORITY.has(item.priority);
    return item;
  };
  // Belt and braces: the JQL already filters by team, but never count another team's issue.
  const sameTeam = (items, label) => {
    const other = items.filter((i) => i.team !== scope.team);
    if (other.length) warnings.push(`${other.length} ${label} issue(s) had a different team value and were left out: ${other.map((i) => i.key).join(', ')}`);
    return items.filter((i) => i.team === scope.team);
  };

  const openRes = await client.search({ jql: `${base} AND statusCategory != Done ORDER BY created ASC`, fields, limit: 2000 });
  if (openRes.truncated) warnings.push('Open issue list truncated; counts may be low');
  const open = sameTeam(openRes.issues.map(toItem), 'open');
  const resolvedRes = await client.search({ jql: `${base} AND statusCategory = Done AND statusCategoryChangedDate >= -${r.resolvedDays}d ORDER BY statusCategoryChangedDate DESC`, fields, limit: 500 });
  const resolved = sameTeam(resolvedRes.issues.map(toItem), 'resolved');

  const engineering = open.filter((i) => !i.waiting);
  const waitingOn = open.filter((i) => i.waiting);
  const sevKey = (i) => i.severity ?? '(no severity)';
  const urgent = open.filter((i) => i.urgent)
    .sort((a, b) => sevRank(a) - sevRank(b) || Number(a.waiting) - Number(b.waiting) || b.ageDays - a.ageDays);
  const blocked = open.map((i) => ({ ...brief(i), why: blockReasons(i) })).filter((b) => b.why.length);
  const stalled = engineering.filter((i) => i.idleDays >= r.staleDays && !blockReasons(i).length).sort((a, b) => b.idleDays - a.idleDays);
  const longWait = waitingOn.filter((i) => i.idleDays >= r.waitingDays).sort((a, b) => b.idleDays - a.idleDays);
  const unowned = open.filter((i) => !i.owner);
  const owners = Object.entries(count(engineering, (i) => i.owner ?? '(no owner)')).sort((a, b) => b[1] - a[1]);
  const concentrated = owners.filter(([name, n]) => name !== '(no owner)' && engineering.length >= 8 && (n / engineering.length) * 100 >= r.ownerShare);

  const report = {
    report: 'prod',
    scope: { ...scope, jql: base },
    asOf: now.toISOString(),
    comparedWith: previous?.takenAt ?? null,
    totals: {
      open: open.length,
      withEngineering: engineering.length,
      waiting: waitingOn.length,
      urgent: urgent.length,
      urgentWithEngineering: urgent.filter((i) => !i.waiting).length,
      new: open.filter((i) => i.ageDays != null && i.ageDays < r.newDays).length,
      resolved: resolved.length,
      blocked: blocked.length,
      stalled: stalled.length,
      longWait: longWait.length,
      unowned: unowned.length,
    },
    bySeverity: Object.fromEntries([...SEVERITY_ORDER, '(no severity)'].map((s) => [s, open.filter((i) => sevKey(i) === s).length]).filter(([, n]) => n)),
    byPriority: count(open, (i) => i.priority ?? '(none)'),
    byStatus: Object.entries(count(open, (i) => i.status)).sort((a, b) => b[1] - a[1]),
    byComponent: Object.entries(count(open.flatMap((i) => (i.components.length ? i.components : ['(no component)']).map((c) => ({ c }))), (x) => x.c)).sort((a, b) => b[1] - a[1]),
    aging: AGE_BUCKETS.map(([max, label], k) => {
      const min = k ? AGE_BUCKETS[k - 1][0] + 1 : 0;
      const xs = open.filter((i) => i.ageDays >= min && i.ageDays <= max);
      return { label, all: xs.length, urgent: xs.filter((i) => i.urgent).length };
    }),
    urgent: urgent.map(brief),
    blocked,
    stalled: stalled.map(brief),
    longWait: longWait.map(brief),
    unowned: unowned.map(brief),
    owners: owners.slice(0, 8).map(([name, n]) => ({ name, open: n })),
    concentrated: concentrated.map(([name, n]) => ({ name, open: n, share: Math.round((n / engineering.length) * 100) })),
    resolved: resolved.map((i) => ({ ...brief(i), resolution: i.resolution, resolvedAt: i.resolved, daysToResolve: i.created && i.resolved ? daysBetween(i.created, i.resolved) : null })),
    warnings,
    rules: r,
    snapshot: Object.fromEntries(open.map((i) => [i.key, [i.phase, i.severity, i.owner, i.status]])),
  };
  report.changes = previous ? prodChanges(previous.issues, report.snapshot, resolved.map((i) => i.key)) : null;
  report.risks = prodRisks(report);
  report.followUps = prodFollowUps(report);
  return report;
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

const sevRank = (i) => { const k = SEVERITY_ORDER.indexOf(i.severity); return k === -1 ? (URGENT_PRIORITY.has(i.priority) ? 1.5 : 9) : k; };

function brief(i) {
  return {
    key: i.key, summary: truncate(i.summary, 90), status: i.status, severity: i.severity, priority: i.priority, owner: i.owner,
    components: i.components, ageDays: i.ageDays, idleDays: i.idleDays, waiting: i.waiting, url: i.url,
  };
}

// Since the last report: new, resolved (gone from open), severity/status/owner changes.
export function prodChanges(prev = {}, curr = {}, resolvedKeys = []) {
  const added = Object.keys(curr).filter((k) => !(k in prev));
  const gone = Object.keys(prev).filter((k) => !(k in curr));
  const severity = [];
  const status = [];
  const owner = [];
  for (const [k, [, sev, own, st]] of Object.entries(curr)) {
    const p = prev[k];
    if (!p) continue;
    if (p[1] !== sev) severity.push({ key: k, from: p[1], to: sev });
    if (p[3] !== st) status.push({ key: k, from: p[3], to: st });
    if (p[2] !== own) owner.push({ key: k, from: p[2], to: own });
  }
  return { added, resolved: gone.filter((k) => resolvedKeys.includes(k)), leftOther: gone.filter((k) => !resolvedKeys.includes(k)), severity, status, owner };
}

// Inferred risks — each says what triggered it.
function prodRisks(rep) {
  const t = rep.totals;
  const risks = [];
  const urgentEng = rep.urgent.filter((i) => !i.waiting);
  const stuckUrgent = urgentEng.filter((i) => i.idleDays >= rep.rules.staleDays);
  if (stuckUrgent.length) risks.push(`${stuckUrgent.length} critical/high issue(s) with engineering and no update in ${rep.rules.staleDays}+ days`);
  const blockedUrgent = rep.blocked.filter((b) => ['Critical', 'High'].includes(b.severity));
  if (blockedUrgent.length) risks.push(`${blockedUrgent.length} critical/high issue(s) blocked`);
  const unownedUrgent = rep.unowned.filter((i) => ['Critical', 'High'].includes(i.severity));
  if (unownedUrgent.length) risks.push(`${unownedUrgent.length} critical/high issue(s) with no owner`);
  if (t.longWait) risks.push(`${t.longWait} issue(s) waiting outside engineering for ${rep.rules.waitingDays}+ days`);
  if (rep.concentrated.length) risks.push(`ownership concentrated: ${rep.concentrated.map((c) => `${c.name} holds ${c.share}% of engineering issues`).join('; ')}`);
  if (t.new > t.resolved) risks.push(`more new (${t.new}) than resolved (${t.resolved}) in the last ${rep.rules.newDays} days`);
  const unprioritised = rep.urgent.filter((i) => ['Critical', 'High'].includes(i.severity) && (!i.priority || /unprioriti[sz]ed/i.test(i.priority)));
  if (unprioritised.length) risks.push(`${unprioritised.length} critical/high-severity issue(s) still "Unprioritized"`);
  return risks;
}

function prodFollowUps(rep) {
  const out = [];
  const keys = (xs, n = 6) => xs.slice(0, n).map((i) => i.key).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '');
  const urgentEng = rep.urgent.filter((i) => !i.waiting);
  for (const i of urgentEng.filter((x) => x.severity === 'Critical').slice(0, 5)) {
    // A fix already in QA / review needs a verification and release date, not a fix ETA.
    const ask = /qa|^review|accept|verif/i.test(i.status) ? 'Confirm when the fix for' : 'Get a fix ETA on';
    out.push({ rule: 'critical', keys: [i.key], text: `${ask} Critical ${i.key} from ${i.owner ?? 'an owner (none assigned)'}${ask.startsWith('Confirm') ? ' will be verified and released' : ''} — ${i.status}, open ${i.ageDays} d, last update ${i.idleDays} d ago` });
  }
  for (const b of rep.blocked.slice(0, 5)) out.push({ rule: 'blocked', keys: [b.key], text: `Unblock ${b.key} (${b.severity ?? 'no severity'}, ${b.owner ?? 'no owner'}): ${b.why.join('; ')}` });
  const stuck = rep.stalled.filter((i) => ['Critical', 'High'].includes(i.severity));
  if (stuck.length) out.push({ rule: 'stalled', keys: stuck.map((i) => i.key), text: `Check in on ${stuck.length} critical/high issue(s) with no update in ${rep.rules.staleDays}+ days: ${keys(stuck)}` });
  const unowned = rep.unowned;
  if (unowned.length) out.push({ rule: 'no-owner', keys: unowned.map((i) => i.key), text: `Assign an owner to ${unowned.length} issue(s): ${keys(unowned)}` });
  if (rep.longWait.length) {
    out.push({ rule: 'long-wait', keys: rep.longWait.map((i) => i.key), text: `Chase or close ${rep.longWait.length} issue(s) waiting ${rep.rules.waitingDays}+ days (${[...new Set(rep.longWait.map((i) => i.status))].join(', ')}), oldest first: ${keys(rep.longWait)}` });
  }
  const unprioritised = rep.urgent.filter((i) => ['Critical', 'High'].includes(i.severity) && (!i.priority || /unprioriti[sz]ed/i.test(i.priority)));
  if (unprioritised.length) out.push({ rule: 'unprioritised', keys: unprioritised.map((i) => i.key), text: `Ask for a priority on ${unprioritised.length} critical/high-severity issue(s) marked "Unprioritized": ${keys(unprioritised)}` });
  for (const c of rep.concentrated) out.push({ rule: 'concentration', keys: [], text: `${c.name} owns ${c.open} of ${rep.totals.withEngineering} engineering-active issues (${c.share}%) — check capacity` });
  return out;
}

// ─── Rendering (Teams-card-friendly markdown; no tables) ──────────────────────
const link = (i) => `[${i.key}](${i.url})`;

export function renderProdReport(rep) {
  const t = rep.totals;
  const n = rep.rules.listLimit;
  const lines = [`**🚨 Production issues — ${rep.scope.team}** (as of ${rep.asOf.slice(0, 16).replace('T', ' ')} UTC)`];
  lines.push(`Scope: ${rep.scope.issueType} in ${rep.scope.project} where Team = ${rep.scope.team} (each issue's team re-checked).`);
  if (rep.comparedWith) lines.push(`Changes are compared with the report from ${rep.comparedWith.slice(0, 10)}.`);
  for (const w of rep.warnings) lines.push(`- ⚠️ ${w}`);

  lines.push('', '**Facts (from Jira)**');
  lines.push(`- **${t.open} open**: ${t.withEngineering} with engineering · ${t.waiting} waiting (${rep.scope.waitingStatuses.join(', ') || 'none configured'})`);
  lines.push(`- Severity: ${Object.entries(rep.bySeverity).map(([k, v]) => `${k} ${v}`).join(' · ')} — critical/high: ${t.urgent} (${t.urgentWithEngineering} with engineering)`);
  lines.push(`- Priority: ${Object.entries(rep.byPriority).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push(`- Last ${rep.rules.newDays} days: ${t.new} new · ${t.resolved} resolved`);
  lines.push(`- Age: ${rep.aging.map((a) => `${a.label} ${a.all}${a.urgent ? ` (${a.urgent} crit/high)` : ''}`).join(' · ')}`);
  lines.push(`- Status: ${rep.byStatus.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push(`- Components: ${rep.byComponent.slice(0, 6).map(([k, v]) => `${k} ${v}`).join(' · ')}${rep.byComponent.length > 6 ? ' …' : ''}`);
  lines.push(`- Owners (engineering-active): ${rep.owners.map((o) => `${o.name} ${o.open}`).join(' · ')}`);

  if (rep.changes) {
    const c = rep.changes;
    const bits = [
      c.added.length && `new: ${c.added.filter((k) => !(c.reopened ?? []).includes(k)).join(', ') || '—'}`,
      c.reopened?.length && `↩ reopened (resolved earlier, open again): ${c.reopened.join(', ')}`,
      c.resolved.length && `resolved: ${c.resolved.join(', ')}`,
      c.leftOther.length && `no longer in scope: ${c.leftOther.join(', ')}`,
      c.severity.length && `severity: ${c.severity.map((x) => `${x.key} ${x.from ?? 'none'} → ${x.to ?? 'none'}`).join('; ')}`,
      c.status.length && `status: ${c.status.slice(0, 10).map((x) => `${x.key} ${x.from} → ${x.to}`).join('; ')}${c.status.length > 10 ? ` +${c.status.length - 10} more` : ''}`,
      c.owner.length && `owner: ${c.owner.map((x) => `${x.key} ${x.from ?? 'none'} → ${x.to ?? 'none'}`).join('; ')}`,
    ].filter(Boolean);
    lines.push('', '**Since last report**', ...(bits.length ? bits.map((b) => `- ${b}`) : ['- No changes']));
  }

  const row = (i) => `- ${link(i)} ${i.summary} — ${i.severity ?? 'no severity'}/${i.priority ?? '—'} — ${i.status} — ${i.owner ?? 'no owner'} — open ${i.ageDays} d, updated ${i.idleDays} d ago`;
  const eng = rep.urgent.filter((i) => !i.waiting);
  const wait = rep.urgent.filter((i) => i.waiting);
  lines.push('', `**Critical and high — with engineering** (${eng.length})`);
  if (!eng.length) lines.push('- None');
  lines.push(...eng.slice(0, n).map(row));
  if (eng.length > n) lines.push(`- …and ${eng.length - n} more`);
  if (wait.length) {
    lines.push('', `**Critical and high — waiting** (${wait.length})`);
    lines.push(...wait.slice(0, 5).map(row));
    if (wait.length > 5) lines.push(`- …and ${wait.length - 5} more`);
  }
  lines.push('', `**Blocked** (${rep.blocked.length})`);
  if (!rep.blocked.length) lines.push('- None');
  for (const b of rep.blocked.slice(0, n)) lines.push(`- ${link(b)} ${b.summary} — ${b.severity ?? 'no severity'} — ${b.owner ?? 'no owner'} — ${b.why.join('; ')}`);
  lines.push('', `**Stalled with engineering** (no update ${rep.rules.staleDays}+ days, not blocked: ${rep.stalled.length})`);
  if (!rep.stalled.length) lines.push('- None');
  lines.push(...rep.stalled.slice(0, n).map(row));
  if (rep.stalled.length > n) lines.push(`- …and ${rep.stalled.length - n} more`);
  if (rep.longWait.length) lines.push('', `**Waiting ${rep.rules.waitingDays}+ days** (${rep.longWait.length}): ${rep.longWait.slice(0, 12).map((i) => `${i.key} (${i.idleDays} d)`).join(', ')}${rep.longWait.length > 12 ? ' …' : ''}`);
  if (rep.unowned.length) lines.push('', `**No owner** (${rep.unowned.length})`, ...rep.unowned.slice(0, n).map(row));
  lines.push('', `**Recently resolved** (last ${rep.rules.resolvedDays} days: ${rep.resolved.length})`);
  if (!rep.resolved.length) lines.push('- None');
  for (const i of rep.resolved.slice(0, n)) lines.push(`- ${link(i)} ${i.summary} — ${i.status}${i.resolution ? ` (${i.resolution})` : ''} — ${i.severity ?? 'no severity'} — took ${i.daysToResolve ?? '?'} d`);

  lines.push('', '**⚠️ Inferred (rules, not Jira facts)**');
  if (!rep.risks.length) lines.push('- No risks flagged by the rules');
  for (const r of rep.risks) lines.push(`- Risk: ${r}`);
  lines.push('', `**➡️ Recommended follow-ups**${rep.followUpsSource === 'claude' ? ' (prioritised by Claude from the facts above)' : ' (rule-based)'}`);
  if (!rep.followUps.length) lines.push('- Nothing needs your attention');
  for (const f of rep.followUps) lines.push(followUpLine(f));
  lines.push(...learningLines(rep.learning, { recurring: rep.recurring ?? [], days: rep.recurrenceDays }));
  return lines.join('\n');
}
