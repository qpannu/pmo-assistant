import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureReport, renderFeatureReport, stageResolver, devQaProgress, addWorkingDays, blockedStage, FEATURE_DEFAULTS } from '../src/reports/features.js';
import { boardPhases } from '../src/reports/board.js';
import { addFeature, removeFeature, listFeatures } from '../src/reports/registry.js';
import { runReport } from '../src/reports/index.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const NOW = new Date('2026-11-05T12:00:00Z');
const S = {
  open: { id: '1', name: 'Open', statusCategory: { key: 'new' } },
  prog: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  blocked: { id: '10051', name: 'Blocked', statusCategory: { key: 'new' } },
  done: { id: '10002', name: 'Done', statusCategory: { key: 'done' } },
  closed: { id: '6', name: 'Closed', statusCategory: { key: 'done' } },
};
const TYPES = { Initiative: 2, Epic: 1, Story: 0, Bug: 0 };

function issue(key, type, status, { parent = null, owner = 'Ann', priority = 'Medium', due = null, updated = '2026-11-04T10:00:00.000Z', links = [], versions = [], flagged = false, dev = null, qa = null, adev = null, aqa = null } = {}) {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`, status, issuetype: { name: type, hierarchyLevel: TYPES[type] }, priority: { name: priority },
      assignee: owner ? { accountId: owner, displayName: owner } : null, parent: parent ? { key: parent } : null,
      issuelinks: links, updated, duedate: due, fixVersions: versions, components: [], labels: [],
      customfield_10021: flagged ? [{ value: 'Impediment' }] : null,
      customfield_11309: dev, customfield_11310: qa,
      customfield_10060: adev ? { displayName: adev } : null, customfield_10061: aqa ? { displayName: aqa } : null,
    },
  };
}
const blockedBy = (key, status = S.open) => ({ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key, fields: { status } } });
const dependsOn = (key, status = S.prog) => ({ type: { inward: 'depends by', outward: 'depends on' }, outwardIssue: { key, fields: { status } } });

const DATA = [
  issue('REST-100', 'Initiative', S.prog, { owner: 'Pat' }),
  issue('REST-110', 'Epic', S.prog, { parent: 'REST-100', due: '2026-10-01', owner: null }),     // overdue
  issue('UP-120', 'Epic', S.prog, { parent: 'REST-100', due: '2026-11-12' }),                    // due soon, low progress (other project)
  issue('REST-130', 'Epic', S.open, { parent: 'REST-100' }),                                     // no children
  issue('REST-140', 'Epic', S.closed, { parent: 'REST-100' }),                                   // closed with open child
  issue('REST-111', 'Story', S.done, { parent: 'REST-110' }),
  issue('REST-112', 'Bug', S.prog, { parent: 'REST-110', priority: 'High', versions: [{ id: '1', name: 'POS_7.46.0.6', released: false }] }),
  issue('REST-113', 'Story', S.blocked, { parent: 'REST-110', owner: null }),
  issue('UP-121', 'Story', S.open, { parent: 'UP-120', links: [blockedBy('REST-111', S.done), dependsOn('OTHER-1')] }),
  issue('UP-122', 'Story', S.open, { parent: 'UP-120', links: [blockedBy('REST-113', S.blocked)] }), // blocked inside the feature
  issue('UP-123', 'Story', S.done, { parent: 'UP-120' }),
  issue('UP-124', 'Story', S.open, { parent: 'UP-120' }),
  issue('REST-141', 'Story', S.prog, { parent: 'REST-140', flagged: true, versions: [{ id: '1', name: 'POS_7.46.0.6', released: false }] }),
  issue('REST-200', 'Initiative', S.done),
  issue('REST-210', 'Epic', S.done, { parent: 'REST-200', due: '2026-10-01' }),
  issue('REST-211', 'Story', S.done, { parent: 'REST-210', updated: '2026-09-01T10:00:00.000Z' }),
  issue('REST-300', 'Story', S.prog),
];

function fakeClient(data = DATA) {
  const searches = [];
  const keysIn = (jql) => (jql.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((k) => k.trim());
  return {
    searches,
    fields: async () => [
      { id: 'customfield_10022', name: 'Target start', custom: true }, { id: 'customfield_10023', name: 'Target end', custom: true },
      { id: 'customfield_10021', name: 'Flagged', custom: true }, { id: 'summary', name: 'Summary', custom: false },
      { id: 'customfield_11309', name: 'DEV Hours', custom: true }, { id: 'customfield_11310', name: 'QA Hours', custom: true },
      { id: 'customfield_10060', name: 'Assigned Developer', custom: true }, { id: 'customfield_10061', name: 'Assigned QA', custom: true },
    ],
    search: async ({ jql }) => {
      searches.push(jql);
      if (jql.startsWith('key = ')) return { issues: data.filter((i) => i.key === jql.slice(6)), truncated: false };
      if (jql.startsWith('key in')) return { issues: data.filter((i) => keysIn(jql).includes(i.key)), truncated: false };
      const parents = keysIn(jql);
      let issues = data.filter((i) => parents.includes(i.fields.parent?.key));
      if (jql.includes('subTaskIssueTypes')) issues = issues.filter((i) => i.fields.issuetype.hierarchyLevel >= 0);
      return { issues, truncated: false };
    },
    browseUrl: (k) => `https://jira.example/browse/${k}`,
  };
}
const reg = (...keys) => keys.map((key) => ({ key, note: null, added_at: '2026-11-01T00:00:00.000Z' }));

describe('feature report', () => {
  test('walks Initiative → Epics → issues in three searches, across projects', async () => {
    const client = fakeClient();
    const rep = await buildFeatureReport({ client, features: reg('REST-100', 'REST-200'), now: NOW });
    assert.deepEqual(client.searches, [
      'key in (REST-100,REST-200)',
      'parent in (REST-100,REST-200)',
      'parent in (REST-110,UP-120,REST-130,REST-140,REST-210) AND issuetype not in subTaskIssueTypes()',
    ]);
    const f = rep.features[0];
    assert.deepEqual(f.totals, { epics: 4, epicsDone: 1, issues: 8, done: 2, open: 6, donePct: 25, openBugs: 1, criticalBugs: 1, blocked: 3, unowned: 1 });
    assert.deepEqual(f.epics.map((e) => [e.key, e.total, e.open]), [['REST-110', 3, 2], ['UP-120', 4, 3], ['REST-130', 0, 0], ['REST-140', 1, 1]]);
  });

  test('epic flags, blockers, bugs, outside dependencies and releases are facts from Jira', async () => {
    const f = (await buildFeatureReport({ client: fakeClient(), features: reg('REST-100'), now: NOW })).features[0];
    const flags = Object.fromEntries(f.epics.map((e) => [e.key, e.flags]));
    assert.deepEqual(flags, {
      'REST-110': ['due 2026-10-01 passed 35 day(s) ago with 2 open'],
      'UP-120': ['due in 7 day(s) at 25% done'],
      'REST-130': ['no child issues (not broken down)'],
      'REST-140': ['epic is Closed but 1 child issue(s) open'],
    });
    assert.deepEqual(f.blockers.map((b) => [b.key, b.why]), [
      ['REST-113', ['status Blocked']],
      ['UP-122', ['blocked by REST-113 (Blocked)']],
      ['REST-141', ['flagged as impediment']],
    ]);
    assert.deepEqual(f.criticalBugs.map((b) => b.key), ['REST-112']);
    assert.deepEqual(f.dependencies.map((d) => [d.key, d.waitsOn.map((w) => w.key)]), [['UP-121', ['OTHER-1']]], 'links inside the feature are not outside dependencies');
    assert.deepEqual(f.releases, [{ name: 'POS_7.46.0.6', releaseDate: null, open: 2 }]);
    assert.deepEqual(f.dates, { initiative: null, initiativeStart: null, latestEpicDue: '2026-11-12', epicsWithDate: 2 });
  });

  test('inferred health and risks; follow-ups collapse overdue epics', async () => {
    const rep = await buildFeatureReport({ client: fakeClient(), features: reg('REST-100', 'REST-200'), now: NOW });
    const [a, b] = rep.features;
    assert.deepEqual(a.health, { status: 'off track', reason: 'epics past due with open work', inferred: true });
    assert.deepEqual(a.risks, [
      '1 epic(s) past their due date with open work', '1 epic(s) due within 14 days and under 50% done', '3 blocked issue(s)',
      '1 open high-priority bug(s)', '1 issue(s) waiting on work outside this feature', '1 epic(s) with no child issues',
      '1 closed epic(s) still have open children', '1 open issue(s) without an owner',
    ]);
    assert.equal(b.health.status, 'complete');
    assert.deepEqual(rep.followUps.map((f) => f.rule), ['epic-overdue', 'epic-due-soon', 'blocker', 'blocker', 'blocker', 'critical-bug', 'dependency', 'epic-inconsistent', 'epic-empty', 'no-owner']);
    assert.match(rep.followUps[0].text, /^REST-100: re-plan REST-110 \(no owner\) — due 2026-10-01 passed 35 day\(s\) ago with 2 open$/);
  });

  test('several overdue epics become one follow-up', async () => {
    const data = [...DATA, issue('REST-150', 'Epic', S.prog, { parent: 'REST-100', due: '2026-09-15' }), issue('REST-151', 'Story', S.open, { parent: 'REST-150' })];
    const rep = await buildFeatureReport({ client: fakeClient(data), features: reg('REST-100'), now: NOW });
    const overdue = rep.followUps.filter((f) => f.rule === 'epic-overdue');
    assert.equal(overdue.length, 1);
    assert.match(overdue[0].text, /re-plan 2 epics past their due date \(3 open issues; earliest due 2026-09-15\): REST-150 \(1\), REST-110 \(2\)/);
  });

  test('missing keys, non-initiatives and empty registry are reported, not hidden', async () => {
    const rep = await buildFeatureReport({ client: fakeClient(), features: reg('REST-999', 'REST-300'), now: NOW });
    assert.deepEqual(rep.warnings, ['REST-999 was not found in Jira (deleted, moved or no permission)']);
    assert.equal(rep.features[0].totals.issues, 0);
    const empty = await buildFeatureReport({ client: fakeClient(), features: [], now: NOW });
    assert.deepEqual(empty.warnings, ['No features are tracked. Add one with: npm run features -- add <KEY>']);
  });

  test('markdown: overall health first, facts before inferences, no tables', async () => {
    const rep = await buildFeatureReport({ client: fakeClient(), features: reg('REST-100', 'REST-200'), now: NOW });
    const md = renderFeatureReport({ ...rep, followUpsSource: 'rules' });
    assert.match(md, /\*\*Overall\*\* \(health is inferred; counts are from Jira\)\n- 🔴 \[REST-100\]\(https:\/\/jira\.example\/browse\/REST-100\) Summary of REST-100 — \*\*off track\*\* — dev 25% · QA 25% — 2\/8 issues done, 1\/4 epics closed\n- ✅ \[REST-200\]/);
    assert.match(md, /- Dev progress: \*\*25%\*\* by issues \(2\/8 dev-complete\) · no hours set/);
    assert.match(md, /- Estimated finish: not estimated — open issues have no DEV\/QA Hours, so no estimate/);
    assert.ok(md.indexOf('**Facts (from Jira)**') < md.indexOf('**⚠️ Inferred (rules, not Jira facts)**'));
    assert.match(md, /- \[UP-120\]\(https:\/\/jira\.example\/browse\/UP-120\) Summary of UP-120 — In Progress — 1\/4 done \(25%\) — due 2026-11-12 — 1 blocked — ⚠️ due in 7 day\(s\) at 25% done/);
    assert.doesNotMatch(md, /\|/);
  });
});

describe('tracked-feature registry', () => {
  const config = { reports: { featureSeed: ['REST-100', 'REST-200'] } };

  test('seeds once from config, then add/remove only; removal keeps history', async () => {
    const store = createStore(openDb(':memory:'));
    assert.deepEqual(listFeatures(store, config).tracked.map((f) => f.key), ['REST-100', 'REST-200']);
    removeFeature({ store, config, key: 'rest-100' });
    removeFeature({ store, config, key: 'REST-200' });
    const after = listFeatures(store, config);
    assert.deepEqual([after.tracked.length, after.removed.map((f) => f.key)], [0, ['REST-100', 'REST-200']], 'an emptied list is not re-seeded');
    assert.throws(() => removeFeature({ store, config, key: 'REST-200' }), /not currently tracked/);

    const client = fakeClient();
    assert.deepEqual(await addFeature({ store, config, client, key: 'REST-100', note: 'back' }),
      { key: 'REST-100', result: 'restored', type: 'Initiative', summary: 'Summary of REST-100', warnings: [] });
    assert.equal((await addFeature({ store, config, client, key: 'REST-100' })).result, 'exists');
    assert.deepEqual(store.listHistory('feature', 'REST-100').map((h) => h.event), ['added', 'removed', 'restored']);
  });

  test('add verifies the key in Jira and warns for non-initiatives', async () => {
    const store = createStore(openDb(':memory:'));
    const client = fakeClient();
    await assert.rejects(addFeature({ store, config: { reports: {} }, client, key: 'not a key' }), /not a Jira issue key/);
    await assert.rejects(addFeature({ store, config: { reports: {} }, client, key: 'REST-999' }), /REST-999 was not found in Jira/);
    const story = await addFeature({ store, config: { reports: {} }, client, key: 'rest-300' });
    assert.deepEqual([story.result, story.warnings], ['added', ['REST-300 is a Story, not an initiative; its child issues are reported directly']]);
    const offline = await addFeature({ store, config: { reports: {} }, client: null, key: 'REST-5' });
    assert.deepEqual(offline.warnings, ['Jira is not connected, so the key was not verified']);
  });
});

test('runReport features: snapshots, next-day changes, tracking changes and registry details', async () => {
  const store = createStore(openDb(':memory:'));
  const config = { jira: { releaseWindowDays: 14 }, reports: { boardId: 0, featureSeed: ['REST-100', 'REST-200'] } };
  const day1 = await runReport('features', { client: fakeClient(), store, config, now: new Date('2026-11-04T14:00:00Z') });
  assert.equal(day1.report.features[0].changes, null);
  assert.equal(store.listTrackedFeatures()[0].summary, 'Summary of REST-100', 'seeded rows get their Jira title and type');

  removeFeature({ store, config, key: 'REST-200' });
  await addFeature({ store, config, client: fakeClient(), key: 'REST-300' });
  const moved = DATA.map((i) => (i.key === 'UP-124' ? issue('UP-124', 'Story', S.done, { parent: 'UP-120' }) : i))
    .map((i) => (i.key === 'REST-140' ? issue('REST-140', 'Epic', S.prog, { parent: 'REST-100' }) : i));
  const day2 = await runReport('features', { client: fakeClient(moved), store, config, now: NOW });
  const c = day2.report.features.find((f) => f.key === 'REST-100').changes;
  assert.deepEqual([c.newlyDone, c.epicStatus, c.donePctBefore], [['UP-124'], [{ key: 'REST-140', from: 'Closed', to: 'In Progress' }], 25]);
  assert.deepEqual(day2.report.tracking.added, ['REST-300']);
  assert.deepEqual(day2.report.tracking.removed, ['REST-200']);
  assert.match(day2.markdown, /- Added to tracking since last report: REST-300\n- Removed from tracking since last report: REST-200/);
  assert.match(day2.markdown, /\*\*No longer tracked\*\* \(history kept\): REST-200 \(removed \d{4}-\d{2}-\d{2}\)/);
  assert.match(day2.markdown, /- progress 25% → 38%/);
  assert.ok(store.lastReportSnapshot('features', 'registry', NOW.toISOString()).data.features['REST-200'], 'removed feature history is kept in older snapshots');

  await runReport('features', { client: fakeClient(), store, config, now: new Date('2026-11-06T12:00:00Z'), options: { feature: 'REST-100' } });
  assert.equal(store.lastReportSnapshot('features', 'registry').taken_at, NOW.toISOString(), 'single-feature runs are not saved');
  await assert.rejects(runReport('features', { client: fakeClient(), store, config, options: { feature: 'REST-200' } }), /REST-200 is not a tracked feature/);
});

test('GET/POST/DELETE /features manage the registry', async () => {
  const db = openDb(':memory:');
  const store = createStore(db);
  const scheduler = createScheduler();
  const base = loadConfig();
  const config = { ...base, reports: { ...base.reports, featureSeed: ['REST-100'] } };
  const server = createApp(config, { db, store, scheduler, jiraClient: fakeClient() }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    assert.deepEqual((await (await fetch(`${url}/features`)).json()).tracked.map((f) => f.key), ['REST-100']);
    assert.equal((await fetch(`${url}/features`, { method: 'POST', body: 'key=REST-200' })).status, 415);
    const added = await fetch(`${url}/features`, { method: 'POST', headers: json, body: JSON.stringify({ key: 'REST-200', note: 'Q1' }) });
    assert.equal(added.status, 201);
    assert.equal((await fetch(`${url}/features`, { method: 'POST', headers: json, body: JSON.stringify({ key: 'REST-999' }) })).status, 404);
    assert.equal((await fetch(`${url}/features/REST-100`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${url}/features/REST-100`, { method: 'DELETE' })).status, 404);
    const list = await (await fetch(`${url}/features`)).json();
    assert.deepEqual([list.tracked.map((f) => f.key), list.removed.map((f) => f.key)], [['REST-200'], ['REST-100']]);
  } finally {
    server.close();
    scheduler.stop();
  }
});

describe('dev and QA progress', () => {
  const STAT = [
    ['10051', 'Blocked', 'new'], ['1', 'Open', 'new'], ['3', 'In Progress', 'indeterminate'], ['10006', 'Code Review', 'indeterminate'],
    ['10007', 'Ready for QA', 'new'], ['10044', 'QA in Progress', 'indeterminate'], ['10052', 'Review', 'indeterminate'], ['10002', 'Done', 'done'],
  ].map(([id, name, key]) => ({ id, name, statusCategory: { key } }));
  const BOARD = { columnConfig: { columns: [['Blocked/On Hold', ['10051']], ['Ready for Dev', ['1']], ['Dev in Progress', ['3']], ['Code Review', ['10006']],
    ['Ready for QA', ['10007']], ['QA in Progress', ['10044']], ['Review', ['10052']], ['Accepted', ['10002']]].map(([name, ids]) => ({ name, statuses: ids.map((id) => ({ id })) })) } };
  const phases = boardPhases(BOARD, STAT);
  const stageOf = stageResolver({ phases });
  const at = (statusId) => { const st = STAT.find((x) => x.id === statusId); return { ...phases.phaseOf(st), status: st.name }; };

  test('stages follow the board: Ready for QA starts QA; columns after QA are past it', () => {
    assert.deepEqual(['10051', '1', '3', '10006', '10007', '10044', '10052', '10002'].map((id) => stageOf(at(id))),
      ['blocked', 'notStarted', 'dev', 'dev', 'qa', 'qa', 'afterQa', 'done']);
    assert.equal(stageOf({ phase: 'inProgress', column: '(not on board: QA Testing)', status: 'QA Testing' }), 'qa', 'off-board status by name');
  });

  const rules = { ...FEATURE_DEFAULTS };
  const item = (stage, dev, qa, adev, aqa) => ({ stage, devHrs: dev, qaHrs: qa, assignedDev: adev, assignedQa: aqa });

  test('progress is weighted by hours when most issues have them; remaining hours per person; finish estimate', () => {
    const issues = [
      item('done', 10, 4, 'Ben', 'Brew'),
      item('qa', 8, 6, 'Ben', 'Brew'),          // dev-complete, QA open
      item('dev', 12, 6, 'Ben', 'Brew'),        // QA waits on dev
      item('notStarted', 6, 3, 'Matt', 'Zoe'),
      item('dev', 4, 2, null, null),           // unassigned: left out of the timeline
    ];
    const p = devQaProgress(issues, { today: '2026-11-05', rules });
    assert.deepEqual([p.dev.basis, p.dev.pct, p.dev.hours], ['hours', 45, { total: 40, done: 18, remaining: 22, onIssues: 5 }]);
    assert.deepEqual([p.qa.basis, p.qa.pct, p.qa.issuesComplete], ['hours', 19, 1]);
    assert.deepEqual(p.people.dev.map((x) => [x.name, x.hours, x.issues]), [['Ben', 12, 1], ['Matt', 6, 1], [null, 4, 1]]);
    assert.deepEqual(p.people.qa.map((x) => [x.name, x.hours, x.hoursWaitingOnDev]), [['Brew', 12, 6], ['Zoe', 3, 3], [null, 2, 2]]);
    // dev 12h/6 = 2d, then Brew's 6h waiting on dev = 1d → 3d; QA backlog 12h/6 = 2d → 3 working days.
    assert.deepEqual(p.timeline.estimate, { workingDays: 3, finish: '2026-11-10', devDays: 2, qaDays: 2, qaAfterDevDays: 1 });
    assert.deepEqual(p.timeline.excludes, { unassignedDevHours: 4, unassignedQaHours: 2, openWithoutDevHours: 0, openWithoutQaHours: 0 });
    assert.deepEqual(p.timeline.busiest, { name: 'Ben', role: 'dev', hours: 12, days: 2 });
  });

  test('few estimated issues: progress falls back to issue counts but still reports hours', () => {
    const issues = [item('done', 20, null, 'A', null), item('dev', null, null, 'A', null), item('dev', null, null, 'B', null), item('qa', null, null, 'B', null)];
    const p = devQaProgress(issues, { today: '2026-11-05', rules });
    assert.deepEqual([p.dev.basis, p.dev.pct, p.dev.hoursPct, p.dev.remainingWithoutHours], ['issues', 50, 100, 2]);
    assert.deepEqual(p.timeline.estimate, null);
    assert.match(p.timeline.reason, /no DEV\/QA Hours/);
  });

  test('working days skip weekends', () => {
    assert.equal(addWorkingDays('2026-10-30', 1), '2026-11-02'); // Fri → Mon
    assert.equal(addWorkingDays('2026-10-30', 5), '2026-11-06');
    assert.equal(addWorkingDays('2026-10-30', 0), '2026-10-30');
  });

  test('the report shows dev/QA progress, FYI assignees and the estimate (no follow-ups about assignees)', async () => {
    const data = DATA.map((i) => {
      const hrs = { 'REST-111': [8, 4, 'Ben', 'Brew'], 'REST-112': [6, 2, 'Ben', 'Brew'], 'REST-113': [4, 2, 'Matt', null], 'UP-121': [6, 3, 'Matt', 'Zoe'],
        'UP-122': [2, 1, 'Ben', 'Zoe'], 'UP-123': [3, 1, 'Matt', 'Zoe'], 'UP-124': [5, 2, null, 'Zoe'], 'REST-141': [4, 2, 'Ben', 'Brew'] }[i.key];
      if (!hrs) return i;
      const [dev, qa, adev, aqa] = hrs;
      return { ...i, fields: { ...i.fields, customfield_11309: dev, customfield_11310: qa, customfield_10060: adev && { displayName: adev }, customfield_10061: aqa && { displayName: aqa } } };
    });
    const rep = await buildFeatureReport({ client: fakeClient(data), features: reg('REST-100'), now: NOW });
    const f = rep.features[0];
    assert.deepEqual([f.dev.basis, f.dev.pct, f.qa.pct], ['hours', 29, 29]); // QA: 5 of 17 h on done issues
    assert.ok(f.timeline.estimate.finish > '2026-11-05');
    const md = renderFeatureReport({ ...rep, followUpsSource: 'rules' });
    assert.match(md, /- Dev progress: \*\*29%\*\* by DEV hours \(11\/38 DEV h done, 27 h left; hours on 8\/8 issues\) · 2\/8 issues dev-complete/);
    assert.match(md, /- Assigned developers, remaining dev hours \(FYI\): Ben 12 h \(3\), Matt 10 h \(2\), not assigned 5 h \(1\)/);
    assert.match(md, /- Estimated finish: \*\*~\d{4}-\d{2}-\d{2}\*\* \(\d+ working days: dev ~[\d.]+ d/);
    assert.match(md, /leaves out 5 dev h with no assigned developer/);
    assert.ok(!rep.followUps.some((x) => /assigned (developer|QA)/i.test(x.text)), 'assigned dev/QA are FYI only');
  });
});

describe('Blocked / On Hold: dev or QA, from the change log', () => {
  const ticket = { key: 'REST-1', status: 'Blocked', statusId: '10051', assignedDevId: 'dev-1', assignedQaId: 'qa-1' };
  const move = (by, from, to = 'Blocked', toId = '10051', at = '2026-11-01T10:00:00.000+0000') =>
    ({ created: at, author: by && { accountId: by, displayName: by.toUpperCase() }, items: [{ field: 'status', fromString: from, toString: to, to: toId }] });

  test('the Assigned QA moved it → blocked in QA (dev-complete)', () => {
    assert.deepEqual(blockedStage(ticket, [move('dev-1', 'Dev in Progress', 'Code Review', '10006'), move('qa-1', 'QA in Progress')]),
      { stage: 'qa', role: 'QA', by: 'QA-1', at: '2026-11-01T10:00:00.000+0000', basis: 'moved to Blocked by QA-1, the Assigned QA' });
  });

  test('the Assigned Developer moved it → blocked in dev', () => {
    const r = blockedStage(ticket, [move('dev-1', 'Dev in Progress')]);
    assert.deepEqual([r.stage, r.role, r.basis], ['blocked', 'dev', 'moved to Blocked by DEV-1, the Assigned Developer']);
  });

  test('someone else moved it → the status it came from decides; the latest move counts', () => {
    assert.equal(blockedStage(ticket, [move('pm', 'Ready for QA')]).role, 'QA');
    assert.equal(blockedStage(ticket, [move('pm', 'Code Review')]).role, 'dev');
    const r = blockedStage(ticket, [move('qa-1', 'QA in Progress', 'Blocked', '10051', '2026-10-01'), move('x', 'Blocked', 'Ready for Development', '10004', '2026-10-05'), move('pm', 'Dev in Progress', 'Blocked', '10051', '2026-10-09')]);
    assert.deepEqual([r.role, r.basis], ['dev', 'moved to Blocked by PM from Dev in Progress']);
  });

  test('no change-log entry → treated as in dev, and says so', () => {
    assert.deepEqual(blockedStage(ticket, []), { stage: 'blocked', role: 'dev', basis: 'no change-log entry for the move; treated as in dev' });
  });

  test('the report reads change logs only for blocked tickets and counts QA-blocked ones as dev-complete', async () => {
    const data = DATA.map((i) => (i.key === 'REST-113'
      ? { ...i, fields: { ...i.fields, customfield_11309: 4, customfield_10060: { accountId: 'dev-9', displayName: 'Matt' }, customfield_10061: { accountId: 'qa-9', displayName: 'Zoe' } } }
      : i));
    const asked = [];
    const client = { ...fakeClient(data), changelog: async (key) => { asked.push(key); return [move('qa-9', 'QA in Progress', 'Blocked', '10051')]; } };
    const rep = await buildFeatureReport({ client, features: reg('REST-100'), now: NOW });
    assert.deepEqual(asked, ['REST-113'], 'only Blocked / On Hold tickets');
    const f = rep.features[0];
    assert.equal(f.dev.issuesComplete, 3, 'REST-113 now counts as dev-complete');
    assert.deepEqual(f.blockers.find((b) => b.key === 'REST-113').blockedIn.role, 'QA');
    const md = renderFeatureReport({ ...rep, followUpsSource: 'rules' });
    assert.match(md, /- Blocked \/ On Hold: 0 in dev \(not dev-complete\), 1 in QA \(dev-complete\) — from who moved them there in the change log/);
    assert.match(md, /REST-113\).* — status Blocked — blocked in QA \(moved to Blocked by QA-9, the Assigned QA\)/);

    const failing = { ...fakeClient(data), changelog: async () => { throw new Error('HTTP 403'); } };
    const r2 = await buildFeatureReport({ client: failing, features: reg('REST-100'), now: NOW });
    assert.match(r2.features[0].blockers.find((b) => b.key === 'REST-113').blockedIn.basis, /change log unavailable \(HTTP 403\); treated as in dev/);
  });
});
