// Shared helpers for the Jira reports: maps a board's columns to work phases,
// and reads blocker / dependency links. Everything here is deterministic.

import { normalizeIssue } from '../jira/normalize.js';

// Phases, in board order. 'review' covers code review, build, QA and acceptance review.
export const PHASES = ['todo', 'blocked', 'inProgress', 'review', 'done'];
export const PHASE_LABEL = { todo: 'To do', blocked: 'Blocked', inProgress: 'In progress', review: 'Review / QA', done: 'Done' };

const BLOCKED_RX = /block|hold|imped/i;
const REVIEW_RX = /review|qa|test|build|verif|accept|uat|stag/i;

// Board configuration + all statuses → { columns, phaseOfStatus(id, categoryKey) }.
// Jira's status category alone undercounts progress (e.g. "Ready for QA" is in
// the "new" category on this site), so the board's column order decides:
//   last column → done; "blocked/on hold" → blocked; columns before any
//   in-progress status → todo; review/QA/build columns → review; else in progress.
export function boardPhases(boardConfig, statuses) {
  const category = new Map(statuses.map((s) => [String(s.id), s.statusCategory?.key]));
  const cols = boardConfig.columnConfig?.columns ?? [];
  const lastIdx = cols.length - 1;
  const firstActive = cols.findIndex((c) => c.statuses.some((s) => category.get(String(s.id)) === 'indeterminate'));

  const byStatus = new Map();
  const columns = cols.map((c, i) => {
    let phase;
    if (i === lastIdx || c.statuses.every((s) => category.get(String(s.id)) === 'done')) phase = 'done';
    else if (BLOCKED_RX.test(c.name)) phase = 'blocked';
    else if (firstActive === -1 || i < firstActive) phase = 'todo';
    else if (REVIEW_RX.test(c.name)) phase = 'review';
    else phase = 'inProgress';
    for (const s of c.statuses) byStatus.set(String(s.id), { phase, column: c.name });
    return { name: c.name, phase, statusIds: c.statuses.map((s) => String(s.id)) };
  });

  const fallback = { new: 'todo', indeterminate: 'inProgress', done: 'done' };
  return {
    columns,
    phaseOf(status) {
      const hit = byStatus.get(String(status?.id));
      if (hit) return hit;
      return { phase: fallback[status?.statusCategory?.key] ?? 'todo', column: `(not on board: ${status?.name ?? 'unknown'})` };
    },
  };
}

// Links where this issue waits on another one: "is blocked by" and "depends on".
// Jira semantics: with `inwardIssue`, THIS issue [type.inward] that issue;
// with `outwardIssue`, THIS issue [type.outward] that issue.
export function dependencies(rawIssue) {
  const out = [];
  for (const l of rawIssue.fields?.issuelinks ?? []) {
    let other = null;
    let kind = null;
    if (l.inwardIssue && /is blocked by/i.test(l.type?.inward ?? '')) [other, kind] = [l.inwardIssue, 'blocked by'];
    else if (l.outwardIssue && /^depends on$/i.test(l.type?.outward ?? '')) [other, kind] = [l.outwardIssue, 'depends on'];
    if (!other) continue;
    out.push({
      key: other.key,
      kind,
      status: other.fields?.status?.name ?? null,
      done: other.fields?.status?.statusCategory?.key === 'done',
      summary: other.fields?.summary ?? '',
    });
  }
  return out;
}

// Fields every report reads through the agile API ('flagged', 'sprint' and
// 'closedSprints' are agile-only extras).
export const WORK_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'components', 'fixVersions',
  'issuelinks', 'updated', 'created', 'resolutiondate', 'flagged', 'sprint', 'closedSprints', 'labels'];

// Board configuration, status phases and story point field, in two calls.
export async function loadBoard(client, boardId) {
  const [config, statuses] = await Promise.all([client.boardConfiguration(boardId), client.statuses()]);
  const pointsField = config.estimation?.field?.fieldId ?? null;
  return {
    config,
    name: config.name ?? `Board ${boardId}`,
    filterId: config.filter?.id ?? null,
    phases: boardPhases(config, statuses),
    pointsField,
    fields: pointsField ? [...WORK_FIELDS, pointsField] : WORK_FIELDS,
  };
}

// Raw agile issue → the record every report works with.
export function toWorkItem(raw, { client, board }) {
  const n = normalizeIssue(raw);
  const f = raw.fields ?? {};
  const { phase, column } = board.phases.phaseOf(f.status);
  const pf = board.pointsField;
  return {
    key: n.key,
    summary: n.summary,
    type: n.type,
    status: n.status,
    column,
    phase,
    priority: n.priority,
    owner: n.assignee?.name ?? null,
    points: pf && typeof f[pf] === 'number' ? f[pf] : null,
    components: (f.components ?? []).map((c) => c.name),
    fixVersions: n.fixVersions,
    flagged: f.flagged === true,
    sprint: f.sprint ? { id: f.sprint.id, name: f.sprint.name, state: f.sprint.state } : null,
    carriedOver: (f.closedSprints ?? []).length,
    updated: f.updated ?? null,
    deps: dependencies(raw),
    url: client.browseUrl(n.key),
  };
}

// Open work that waits on something: blocked column, flagged, or an open "is blocked by" link.
export function blockReasons(i) {
  return [
    i.phase === 'blocked' && `status ${i.status}`,
    i.flagged && 'flagged as impediment',
    ...i.deps.filter((d) => !d.done && d.kind === 'blocked by').map((d) => `blocked by ${d.key} (${d.status})`),
  ].filter(Boolean);
}

export const projectOf = (key) => String(key).split('-')[0];

// Whole days between two instants (b − a), rounded down.
export const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
