import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boardPhases, dependencies } from '../src/reports/board.js';
import { buildScrumReport, renderScrumReport, sprintHealth, SCRUM_DEFAULTS } from '../src/reports/scrum.js';
import { diffSnapshot } from '../src/reports/snapshot.js';
import { refineFollowUps } from '../src/reports/followups.js';
import { runReport } from '../src/reports/index.js';
import { createJiraClient } from '../src/jira/client.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

// Mirrors board 1946: "Ready for QA" is in Jira's "new" category but sits after
// the in-progress columns, so it must count as review, not to do.
const STATUSES = [
  ['10051', 'Blocked', 'new'], ['10079', 'On Hold', 'new'], ['1', 'Open', 'new'], ['10004', 'Ready for Development', 'new'],
  ['3', 'In Progress', 'indeterminate'], ['10005', 'Dev in Progress', 'indeterminate'], ['10006', 'Code Review', 'indeterminate'],
  ['400', 'Building', 'indeterminate'], ['10007', 'Ready for QA', 'new'], ['10044', 'QA in Progress', 'indeterminate'],
  ['10052', 'Review', 'indeterminate'], ['10002', 'Done', 'done'], ['6', 'Closed', 'done'],
].map(([id, name, key]) => ({ id, name, statusCategory: { key } }));
const st = (id) => STATUSES.find((s) => s.id === id);

const BOARD = {
  name: 'Tesla Scrum Board',
  estimation: { field: { fieldId: 'customfield_10026' } },
  columnConfig: {
    columns: [
      ['Blocked/On Hold', ['10051', '10079']], ['Ready for Dev', ['1', '10004']], ['Dev in Progress', ['3', '10005']],
      ['Code Review', ['10006']], ['Ready for Build', ['400']], ['Ready for QA', ['10007']], ['QA in Progress', ['10044']],
      ['Review', ['10052']], ['Accepted', ['10002', '6']],
    ].map(([name, ids]) => ({ name, statuses: ids.map((id) => ({ id })) })),
  },
};

const SPRINT = { id: 77, name: 'Restaurant 2026 Q4.3', state: 'active', startDate: '2026-10-28T12:00:00.000Z', endDate: '2026-11-11T12:00:00.000Z', goal: '' };
const NOW = new Date('2026-11-05T12:00:00Z'); // day 8 of 14 → 57%

function issue(key, statusId, { comps = [], points = null, owner = null, updated = '2026-11-05T09:00:00.000Z', closed = 0, flagged = false, links = [], type = 'Story', priority = 'Medium' } = {}) {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`, status: st(statusId) ?? { id: statusId, name: 'Weird', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: type }, priority: { name: priority },
      assignee: owner ? { accountId: owner, displayName: owner } : null,
      components: comps.map((name) => ({ name })), fixVersions: [], labels: [],
      issuelinks: links, updated, flagged, closedSprints: Array.from({ length: closed }, (_, i) => ({ name: `Old ${i}` })),
      customfield_10026: points,
    },
  };
}

const ISSUES = [
  issue('REST-1', '10002', { comps: ['CAKE POS'], points: 3, owner: 'Ann' }),
  issue('REST-2', '10007', { comps: ['CAKE POS'], points: 5, owner: 'Ben' }),
  issue('REST-3', '10051', { comps: ['Mobile POS v1.0'], points: 2, owner: 'Cy', type: 'Bug' }),
  issue('REST-4', '1', { closed: 4 }),
  issue('REST-5', '10005', { comps: ['CAKE POS 3350'], points: 8, owner: 'Dee', updated: '2026-10-30T09:00:00.000Z', flagged: true }),
  issue('REST-6', '10006', { comps: ['CAKE POS 3350'], points: 3, owner: 'Eve', updated: '2026-10-31T09:00:00.000Z',
    links: [{ type: { inward: 'depends by', outward: 'depends on' }, outwardIssue: { key: 'UP-9', fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } } }] }),
  issue('REST-7', '3', { comps: ['Mobile POS v1.0'], points: 1, owner: 'Fay',
    links: [{ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'REST-99', fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } } }] }),
  issue('REST-8', '999', { comps: ['CAKE POS'], points: 2, owner: 'Gus' }),
];

function fakeClient(issues = ISSUES, sprints = [SPRINT]) {
  const calls = [];
  return {
    calls,
    boardConfiguration: async (id) => (calls.push(`config:${id}`), BOARD),
    statuses: async () => STATUSES,
    boardSprints: async (id, state) => (calls.push(`sprints:${id}:${state}`), { items: sprints, truncated: false }),
    sprintIssues: async (id, sprintId, fields) => (calls.push(`issues:${sprintId}:${fields.includes('customfield_10026')}`), { items: issues, truncated: false }),
    browseUrl: (k) => `https://jira.example/browse/${k}`,
  };
}

describe('board phases and links', () => {
  test('columns map to phases by board order, not Jira status category', () => {
    const p = boardPhases(BOARD, STATUSES);
    assert.deepEqual(p.columns.map((c) => c.phase), ['blocked', 'todo', 'inProgress', 'review', 'review', 'review', 'review', 'review', 'done']);
    assert.equal(p.phaseOf(st('10007')).phase, 'review', 'Ready for QA (category new) counts as review');
    assert.deepEqual(p.phaseOf({ id: '999', name: 'Weird', statusCategory: { key: 'indeterminate' } }), { phase: 'inProgress', column: '(not on board: Weird)' });
  });

  test('"is blocked by" and "depends on" are dependencies; "blocks" and "relates" are not', () => {
    const raw = { fields: { issuelinks: [
      { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'A-1', fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } } },
      { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'A-2', fields: {} } },
      { type: { inward: 'depends by', outward: 'depends on' }, outwardIssue: { key: 'A-3', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } },
      { type: { inward: 'depends by', outward: 'depends on' }, inwardIssue: { key: 'A-4', fields: {} } },
      { type: { inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'A-5', fields: {} } },
    ] } };
    assert.deepEqual(dependencies(raw).map((d) => [d.key, d.kind, d.done]), [['A-1', 'blocked by', false], ['A-3', 'depends on', true]]);
  });
});

describe('scrum report', () => {
  test('facts: phases, points, components (incl. none), progress and lists', async () => {
    const client = fakeClient();
    const rep = await buildScrumReport({ client, boardId: 1946, now: NOW });
    assert.deepEqual(client.calls, ['config:1946', 'sprints:1946:active', 'issues:77:true'], 'story point field requested');
    const s = rep.sprints[0];
    assert.equal(s.daysElapsed, 8);
    assert.equal(s.timePct, 57);
    assert.deepEqual(Object.fromEntries(Object.entries(s.byPhase).map(([k, v]) => [k, v.issues])), { todo: 1, blocked: 1, inProgress: 3, review: 2, done: 1 });
    assert.equal(s.totals.points, 24);
    assert.deepEqual(s.donePct, { issues: 13, points: 13 });
    assert.equal(s.totals.unestimated, 1);
    assert.equal(s.totals.withoutComponent, 1);
    const pos = s.components.find((c) => c.name === 'CAKE POS');
    assert.deepEqual([pos.issues, pos.done, pos.inProgress, pos.points, pos.donePoints, pos.donePct], [3, 1, 2, 10, 3, 30]);
    assert.ok(s.components.some((c) => c.name === '(no component)' && c.todo === 1));
    assert.deepEqual([s.completed.length, s.inProgress.length, s.remaining.length], [1, 5, 2]);
  });

  test('blockers: blocked status, flagged, and open "blocked by" links — each with why', async () => {
    const s = (await buildScrumReport({ client: fakeClient(), boardId: 1946, now: NOW })).sprints[0];
    assert.deepEqual(s.blockers.map((b) => [b.key, b.why]), [
      ['REST-3', ['status Blocked']],
      ['REST-5', ['flagged as impediment']],
      ['REST-7', ['blocked by REST-99 (Open)']],
    ]);
    assert.deepEqual(s.dependencies.map((d) => [d.key, d.waitsOn.map((w) => w.key)]), [['REST-6', ['UP-9']], ['REST-7', ['REST-99']]]);
  });

  test('inferred: at-risk reasons, health and rule-based follow-ups', async () => {
    const s = (await buildScrumReport({ client: fakeClient(), boardId: 1946, now: NOW })).sprints[0];
    assert.deepEqual(s.atRisk.map((i) => [i.key, i.reasons]), [
      ['REST-4', ['not started with 57% of the sprint gone', 'no owner', 'carried over 4 sprints']],
      ['REST-6', ['no update in 5 days', 'depends on UP-9 (In Progress)']],
    ]);
    assert.ok(!s.atRisk.some((i) => i.key === 'REST-5'), 'blockers are not repeated as at-risk');
    assert.equal(s.health.status, 'off track');
    assert.equal(s.health.inferred, true);
    assert.match(s.health.reason, /13% of points done with 57% of the sprint gone \(gap 44 pts\); 1 blocked/);
    const rules = s.followUps.map((f) => f.rule);
    assert.deepEqual(rules, ['blocker', 'blocker', 'blocker', 'no-owner', 'not-started', 'stale', 'chronic-carryover', 'dependency', 'unestimated']);
    assert.match(s.followUps[0].text, /^Unblock REST-3 \(Cy\): status Blocked$/);
  });

  test('health is "too early" in the first days and needs a 15-point gap to be at risk', () => {
    const r = SCRUM_DEFAULTS;
    assert.equal(sprintHealth({ timePct: 10, donePct: 0, basis: 'points', blocked: 0, total: 10, rules: r }).status, 'too early');
    assert.equal(sprintHealth({ timePct: 50, donePct: 40, basis: 'points', blocked: 0, total: 10, rules: r }).status, 'on track');
    assert.equal(sprintHealth({ timePct: 50, donePct: 30, basis: 'points', blocked: 0, total: 10, rules: r }).status, 'at risk');
    assert.equal(sprintHealth({ timePct: 50, donePct: 45, basis: 'points', blocked: 2, total: 10, rules: r }).status, 'at risk', '20% blocked');
  });

  test('sprint filter, empty board and markdown separating facts from inferences', async () => {
    const two = [SPRINT, { ...SPRINT, id: 78, name: 'RA 2.0 2026 Q4.3' }];
    const only = await buildScrumReport({ client: fakeClient(ISSUES, two), boardId: 1946, now: NOW, sprintFilter: 'ra 2.0' });
    assert.deepEqual(only.sprints.map((s) => s.id), [78]);
    const none = await buildScrumReport({ client: fakeClient(ISSUES, []), boardId: 1946, now: NOW });
    assert.deepEqual(none.warnings, ['The board has no active sprint']);

    // Prefix keeps only "Restaurant …" sprints; an explicit --sprint overrides it.
    const four = [...two, { ...SPRINT, id: 79, name: 'KDS V2 2026 Q4.3' }, { ...SPRINT, id: 80, name: 'Ops Restaurant tools' }];
    const rest = await buildScrumReport({ client: fakeClient(ISSUES, four), boardId: 1946, now: NOW, sprintPrefix: 'restaurant' });
    assert.deepEqual(rest.sprints.map((s) => s.name), ['Restaurant 2026 Q4.3'], 'starts with, case-insensitive; not "contains"');
    const override = await buildScrumReport({ client: fakeClient(ISSUES, four), boardId: 1946, now: NOW, sprintPrefix: 'Restaurant', sprintFilter: 'KDS' });
    assert.deepEqual(override.sprints.map((s) => s.id), [79]);
    const missing = await buildScrumReport({ client: fakeClient(ISSUES, [four[2]]), boardId: 1946, now: NOW, sprintPrefix: 'Restaurant' });
    assert.deepEqual(missing.warnings, ['No active sprint name starts with "Restaurant" (active: KDS V2 2026 Q4.3)']);

    const md = renderScrumReport(await buildScrumReport({ client: fakeClient(), boardId: 1946, now: NOW }));
    assert.ok(md.indexOf('**Facts (from Jira)**') < md.indexOf('**⚠️ Inferred (rules, not Jira facts)**'));
    assert.match(md, /- 8 issues \/ 24 pts: To do 1 · Blocked 1 · In progress 3 · Review \/ QA 2 · Done 1/);
    assert.match(md, /- CAKE POS: 1\/3 done \(30% of 10 pts\) · in progress 2 · to do 0/);
    assert.match(md, /- \[REST-7\]\(https:\/\/jira\.example\/browse\/REST-7\) Summary of REST-7 — Fay — blocked by REST-99 \(Open\)/);
    assert.match(md, /Health: \*\*off track\*\*/);
    assert.match(md, /\*\*➡️ Recommended follow-ups\*\* \(rule-based\)/);
    assert.doesNotMatch(md, /\|/, 'no tables (Teams cards do not render them)');
  });
});

describe('snapshots and comparisons', () => {
  test('diff finds done, blocked, moved, added and removed', () => {
    const d = diffSnapshot(
      { A: ['inProgress', 3, 'x'], B: ['todo', 1, 'y'], C: ['review', 2, 'z'], D: ['todo', 1, null] },
      { A: ['done', 3, 'x'], B: ['blocked', 1, 'y'], C: ['inProgress', 2, 'z'], E: ['todo', 1, null] },
    );
    assert.deepEqual(d, { added: ['E'], removed: ['D'], newlyDone: ['A'], newlyBlocked: ['B'], moved: [{ key: 'C', from: 'review', to: 'inProgress', backwards: true }] });
  });

  test('runReport saves a snapshot and compares with the previous day, not an earlier run today', async () => {
    const store = createStore(openDb(':memory:'));
    const config = { reports: { boardId: 1946, staleDays: 3, carryoverSprints: 3 } };
    const day1 = await runReport('scrum', { client: fakeClient(), store, config, now: new Date('2026-11-04T14:00:00Z') });
    assert.equal(day1.report.sprints[0].changes, null, 'nothing to compare on the first run');
    assert.equal(day1.report.sprints[0].snapshot, undefined, 'snapshot kept out of the output');

    const moved = ISSUES.map((i) => (i.key === 'REST-2' ? issue('REST-2', '10002', { comps: ['CAKE POS'], points: 5, owner: 'Ben' }) : i))
      .filter((i) => i.key !== 'REST-8').concat(issue('REST-10', '1', { owner: 'Hal' }));
    const day2 = await runReport('scrum', { client: fakeClient(moved), store, config, now: NOW });
    const again = await runReport('scrum', { client: fakeClient(moved), store, config, now: new Date(NOW.getTime() + 3_600_000) });
    for (const run of [day2, again]) {
      assert.deepEqual(run.report.sprints[0].changes, { added: ['REST-10'], removed: ['REST-8'], newlyDone: ['REST-2'], newlyBlocked: [], moved: [] });
      assert.match(run.markdown, /\*\*Since last report\*\*\n- Done: REST-2\n- Added to sprint: REST-10\n- Removed from sprint: REST-8/);
    }
    await runReport('scrum', { client: fakeClient(), store, config, now: new Date('2026-11-06T12:00:00Z'), options: { sprint: 'Restaurant' } });
    assert.equal(store.lastReportSnapshot('scrum', 1946).taken_at, new Date(NOW.getTime() + 3_600_000).toISOString(), 'filtered runs are not saved');
  });

  test('runReport needs a board and a Jira client', async () => {
    const store = createStore(openDb(':memory:'));
    await assert.rejects(runReport('scrum', { client: fakeClient(), store, config: { reports: { boardId: 0 } } }), /JIRA_BOARD_ID/);
    await assert.rejects(runReport('scrum', { client: null, store, config: { reports: { boardId: 1 } } }), /Jira is not configured/);
    await assert.rejects(runReport('nope', { client: fakeClient(), store, config: {} }), /Unknown report "nope"/);
  });
});

describe('Claude follow-up ordering', () => {
  const rules = [
    { rule: 'blocker', keys: ['REST-3'], text: 'Unblock REST-3 (Cy): status Blocked', ref: 'aaa111' },
    { rule: 'no-owner', keys: ['REST-4'], text: 'Assign owners to 1 issue(s): REST-4', ref: 'bbb222' },
    { rule: 'stale', keys: ['REST-6'], text: 'Check in on REST-6', ref: 'ccc333' },
  ];

  test('reorders by index, keeps refs, ignores invented keys, and drops nothing', async () => {
    const claude = { enabled: true, complete: async () => ({ json: { followUps: [
      { index: 2, text: 'Ask Eve about REST-6 today' },
      { index: 0, text: 'Close REST-12345 now' },  // cites a key that isn't in the original → original text kept
      { index: 9, text: 'Made up' },               // no such follow-up → ignored
      { index: 2, text: 'duplicate' },             // already picked → ignored
    ] } }) };
    const r = await refineFollowUps({ claude, purpose: 't', facts: {}, followUps: rules });
    assert.equal(r.source, 'claude');
    assert.deepEqual(r.followUps.map((f) => [f.ref, f.text]), [
      ['ccc333', 'Ask Eve about REST-6 today'],
      ['aaa111', 'Unblock REST-3 (Cy): status Blocked'],
      ['bbb222', 'Assign owners to 1 issue(s): REST-4'],
    ]);
  });

  test('falls back to the rules when Claude is off or fails', async () => {
    assert.deepEqual(await refineFollowUps({ claude: { enabled: false }, purpose: 't', facts: {}, followUps: rules }), { followUps: rules, source: 'rules' });
    const failing = { enabled: true, complete: async () => { throw new Error('limit'); } };
    assert.equal((await refineFollowUps({ claude: failing, purpose: 't', facts: {}, followUps: rules })).source, 'rules');
  });
});

test('Jira client agile pagination uses startAt and stops at total', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push(`${u.pathname}?startAt=${u.searchParams.get('startAt')}&max=${u.searchParams.get('maxResults')}`);
    const start = Number(u.searchParams.get('startAt'));
    const issues = Array.from({ length: Math.min(100, 150 - start) }, (_, i) => ({ key: `R-${start + i}` }));
    return { ok: true, json: async () => ({ issues, total: 150, startAt: start }) };
  };
  const c = createJiraClient({ baseUrl: 'https://j.example', email: 'e', apiToken: 't' }, { fetchImpl });
  const r = await c.sprintIssues(1946, 77, ['summary']);
  assert.equal(r.items.length, 150);
  assert.equal(r.truncated, false);
  assert.deepEqual(seen, ['/rest/agile/1.0/board/1946/sprint/77/issue?startAt=0&max=100', '/rest/agile/1.0/board/1946/sprint/77/issue?startAt=100&max=100']);
  const capped = await c.sprintIssues(1946, 77, ['summary'], 100);
  assert.deepEqual([capped.items.length, capped.truncated], [100, true]);
});

test('GET /reports/scrum returns JSON or markdown; errors are clear', async () => {
  const db = openDb(':memory:');
  const store = createStore(db);
  const scheduler = createScheduler();
  const base = loadConfig();
  const config = { ...base, reports: { ...base.reports, boardId: 1946 } };
  const servers = [
    createApp(config, { db, store, scheduler, jiraClient: fakeClient() }).listen(0, '127.0.0.1'),
    createApp(base, { db, store, scheduler, jiraClient: fakeClient() }).listen(0, '127.0.0.1'),
  ];
  await Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r))));
  const [url, noBoard] = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  try {
    const json = await (await fetch(`${url}/reports/scrum`)).json();
    assert.equal(json.sprints[0].name, 'Restaurant 2026 Q4.3');
    const md = await fetch(`${url}/reports/scrum?format=md`);
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    assert.match(await md.text(), /^\*\*🏃 Scrum report — Tesla Scrum Board\*\*/);
    assert.equal((await fetch(`${url}/reports/other`)).status, 404);
    const missing = await fetch(`${noBoard}/reports/scrum`);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /JIRA_BOARD_ID/);
  } finally {
    servers.forEach((s) => s.close());
    scheduler.stop();
  }
});
