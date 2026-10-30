import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseReport, renderReleaseReport, productLine } from '../src/reports/releases.js';
import { runReport } from '../src/reports/index.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const STATUSES = [
  ['10051', 'Blocked', 'new'], ['1', 'Open', 'new'], ['3', 'In Progress', 'indeterminate'],
  ['10007', 'Ready for QA', 'new'], ['10044', 'QA in Progress', 'indeterminate'], ['10002', 'Done', 'done'],
].map(([id, name, key]) => ({ id, name, statusCategory: { key } }));
const BOARD = {
  name: 'Tesla Scrum Board',
  filter: { id: '16577' },
  estimation: { field: { fieldId: 'customfield_10026' } },
  columnConfig: {
    columns: [['Blocked/On Hold', ['10051']], ['Ready for Dev', ['1']], ['Dev in Progress', ['3']], ['Ready for QA', ['10007']], ['QA in Progress', ['10044']], ['Accepted', ['10002']]]
      .map(([name, ids]) => ({ name, statuses: ids.map((id) => ({ id })) })),
  },
};
const NOW = new Date('2026-11-05T12:00:00Z');
const ACTIVE = { id: 77, name: 'Restaurant 2026 Q4.3', state: 'active' };

const V = {
  pos: { id: '1', name: 'POS_7.46.0.6', releaseDate: null },
  ccl: { id: '2', name: 'CCL_8.886.22.10', releaseDate: '2026-11-01' },
  mpos: { id: '3', name: 'MPOS_1.22.x', releaseDate: '2026-11-12' },
  done: { id: '4', name: 'POS_7.45.0.29', releaseDate: null },
  kds: { id: '5', name: 'KDS_EA_010.0', releaseDate: null },
  madRest: { id: '10', name: 'Madpay_1.1.106', releaseDate: null },
  madUp: { id: '20', name: 'Madpay_1.1.106', releaseDate: null },
  olo: { id: '6', name: 'OLO 2.1.X', releaseDate: null },
  old: { id: '7', name: 'POS_7.40.0.0', releaseDate: '2026-01-01', released: true },
};

function issue(key, statusId, versions, { type = 'Story', priority = 'Medium', owner = 'Ann', sprint = ACTIVE, updated = '2026-11-04T10:00:00.000Z', comps = ['CAKE POS 3350'] } = {}) {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`, status: STATUSES.find((s) => s.id === statusId), issuetype: { name: type }, priority: { name: priority },
      assignee: owner ? { accountId: owner, displayName: owner } : null, components: comps.map((name) => ({ name })),
      fixVersions: versions.map((v) => ({ released: false, ...v })), issuelinks: [], updated, flagged: false, sprint, closedSprints: [], labels: [],
    },
  };
}

const ISSUES = [
  issue('REST-1', '10002', [V.pos]),
  issue('REST-2', '10007', [V.pos, V.mpos]),
  issue('REST-3', '10051', [V.ccl, V.olo], { owner: 'Cy' }),
  issue('REST-4', '1', [V.ccl], { sprint: null }),
  issue('REST-5', '1', [V.mpos], { owner: null, sprint: { id: 90, name: 'Future', state: 'future' } }),
  issue('REST-6', '3', [V.mpos], { type: 'Bug', priority: 'High', comps: [] }),
  issue('REST-7', '10002', [V.done, V.old]),
  issue('REST-8', '1', [V.kds], { updated: '2026-09-01T10:00:00.000Z', sprint: null }),
  issue('REST-9', '10002', [V.madRest]),
  issue('UP-9', '10044', [V.madUp], { type: 'PROD_PRB' }),
];

function fakeClient(issues = ISSUES) {
  const calls = [];
  return {
    calls,
    boardConfiguration: async () => BOARD,
    statuses: async () => STATUSES,
    boardIssues: async (id, jql, fields) => (calls.push([id, jql, fields.includes('sprint')]), { items: issues, truncated: false }),
    browseUrl: (k) => `https://jira.example/browse/${k}`,
  };
}

describe('release report', () => {
  test('scope is the board filter plus unreleased versions; versions are grouped by name', async () => {
    const client = fakeClient();
    const rep = await buildReleaseReport({ client, boardId: 1946, now: NOW });
    assert.deepEqual(client.calls, [[1946, 'fixVersion in unreleasedVersions()', true]]);
    assert.deepEqual(rep.warnings, []);
    assert.deepEqual(rep.totals, { versions: 7, active: 5, dormant: 1, complete: 1, issues: 10, inMoreThanOneVersion: 2, approaching: 1, datePassed: 1, noDate: 3 });
    const mad = rep.active.find((x) => x.name === 'Madpay_1.1.106');
    assert.deepEqual([mad.versionIds, mad.total, mad.done], [['10', '20'], 2, 1], 'REST and UP versions with one name are one release');
    assert.ok(!rep.active.some((x) => x.name === 'POS_7.40.0.0'), 'released versions are ignored');
    assert.deepEqual(rep.active.map((x) => x.name), ['CCL_8.886.22.10', 'MPOS_1.22.x', 'POS_7.46.0.6', 'OLO 2.1.X', 'Madpay_1.1.106'], 'date passed, due soon, then undated by open work');
  });

  test('facts per release: dates, progress by phase and component, bugs, blocked, scheduling', async () => {
    const rep = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW });
    const ccl = rep.active.find((x) => x.name === 'CCL_8.886.22.10');
    assert.deepEqual([ccl.dateStatus, ccl.daysToTarget, ccl.total, ccl.open, ccl.notInActiveSprint], ['date passed', -4, 2, 2, 1]);
    assert.deepEqual(ccl.blocked.map((b) => [b.key, b.why]), [['REST-3', ['status Blocked']]]);
    const mpos = rep.active.find((x) => x.name === 'MPOS_1.22.x');
    assert.deepEqual([mpos.dateStatus, mpos.daysToTarget, mpos.bucket, mpos.productLine], ['due soon', 7, true, 'MPOS']);
    assert.deepEqual(mpos.byPhase, { todo: 1, blocked: 0, inProgress: 1, review: 1, done: 0 });
    assert.deepEqual(mpos.urgentBugs.map((b) => b.key), ['REST-6']);
    assert.deepEqual(mpos.components, [{ name: 'CAKE POS 3350', issues: 2, done: 0 }, { name: '(no component)', issues: 1, done: 0 }]);
    assert.equal(mpos.notInActiveSprint, 1, 'a future sprint is not the active sprint');
    assert.deepEqual(rep.complete.map((x) => x.name), ['POS_7.45.0.29']);
    assert.deepEqual(rep.dormant.map((x) => [x.name, x.idleDays]), [['KDS_EA_010.0', 65]]);
  });

  test('inferred readiness and risks are rule-based and labelled', async () => {
    const rep = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW });
    const get = (n) => rep.active.find((x) => x.name === n);
    assert.deepEqual(get('CCL_8.886.22.10').readiness, { status: 'blocked', inferred: true });
    assert.equal(get('POS_7.46.0.6').readiness.status, 'in final review / QA');
    assert.equal(get('MPOS_1.22.x').readiness.status, 'at risk');
    assert.deepEqual(get('MPOS_1.22.x').risks, [
      'due in 7 day(s) and 1 issue(s) not started', '1 open high-priority bug(s)', '1 open issue(s) not in an active sprint',
      '1 open issue(s) without an owner', 'placeholder version (".x"), not a specific build',
    ]);
    assert.deepEqual(get('CCL_8.886.22.10').risks.slice(0, 2), ['target date 2026-11-01 passed 4 day(s) ago with 2 open', '1 blocked']);
  });

  test('follow-ups: decisions per release, one line per blocker across releases, housekeeping', async () => {
    const rep = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW });
    const byRule = (r) => rep.followUps.filter((f) => f.rule === r).map((f) => f.text);
    assert.deepEqual(byRule('date-passed'), ['Decide on CCL_8.886.22.10: target 2026-11-01 passed 4 day(s) ago with 2 open — set a new date or descope']);
    assert.deepEqual(byRule('due-soon'), ['MPOS_1.22.x is due 2026-11-12 (7 day(s)) with 3 open (1 not started) — confirm go/no-go']);
    assert.deepEqual(byRule('blocker'), ['Unblock REST-3 (Cy) — holds up CCL_8.886.22.10, OLO 2.1.X: status Blocked']);
    assert.deepEqual(byRule('urgent-bug'), ['Track High bug REST-6 (Ann, In Progress) — in MPOS_1.22.x']);
    assert.match(byRule('no-date')[0], /^Set target dates for 2 active release\(s\) with no date: POS_7\.46\.0\.6, Madpay_1\.1\.106$/);
    assert.match(byRule('bucket')[0], /MPOS_1\.22\.x \(3 open\), OLO 2\.1\.X \(1 open\)/);
    assert.match(byRule('complete-unreleased')[0], /^1 version\(s\) have all board work done but aren't marked released .*POS_7\.45\.0\.29$/);
    assert.match(byRule('dormant')[0], /KDS_EA_010\.0/);
    assert.match(byRule('multi-version')[0], /^2 issue\(s\) are tagged with more than one unreleased version/);
  });

  test('version filter and markdown (facts first, inferences labelled, no tables)', async () => {
    const one = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW, versionFilter: 'mpos' });
    assert.deepEqual(one.active.map((x) => x.name), ['MPOS_1.22.x']);
    const none = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW, versionFilter: 'nope' });
    assert.deepEqual(none.warnings, ['No unreleased version with board work matches "nope"']);

    const md = renderReleaseReport({ ...(await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW })), followUpsSource: 'rules' });
    assert.match(md, /Sprint progress is in the Scrum report\./);
    assert.match(md, /- 7 unreleased versions with board work: 5 active · 1 dormant \(no activity 30\+ days\) · 1 with all work done/);
    assert.match(md, /\*\*CCL\*\*\n- \*\*CCL_8\.886\.22\.10\*\* — target 2026-11-01 — passed 4 day\(s\) ago — 0\/2 done \(0%\) · To do 1 · Blocked 1/);
    assert.match(md, /  - ⚠️ Inferred: \*\*blocked\*\* — target date 2026-11-01 passed/);
    assert.match(md, /\*\*All board work done, not marked released\*\* \(1\)\n- POS_7\.45\.0\.29 \(1\)/);
    assert.match(md, /\*\*➡️ Recommended actions and decisions\*\* \(rule-based\)/);
    assert.doesNotMatch(md, /\|/);
  });

  test('issues in a status with no board column are fetched by the board filter and counted', async () => {
    const discovery = issue('REST-50', '1', [V.pos]);
    discovery.fields.status = { id: '99', name: 'Discovery', statusCategory: { key: 'new' } };
    const searches = [];
    const client = {
      ...fakeClient(),
      search: async ({ jql, fields }) => {
        searches.push(jql);
        return jql.startsWith('filter = 16577')
          ? { issues: [...ISSUES, discovery].map((i) => ({ key: i.key, fields: { status: i.fields.status } })) }
          : { issues: [discovery] };
      },
    };
    const rep = await buildReleaseReport({ client, boardId: 1946, now: NOW });
    assert.deepEqual(searches, ['filter = 16577 AND fixVersion in unreleasedVersions()', 'key in (REST-50)']);
    const pos = rep.active.find((x) => x.name === 'POS_7.46.0.6');
    assert.deepEqual([pos.total, pos.byPhase.todo], [3, 1], 'Discovery counts as to do');
    assert.deepEqual(rep.warnings, ['1 issue(s) in a status with no board column (Discovery) are included, counted by status category']);
  });

  test('tracked prefixes keep only matching versions and say how many were left out', async () => {
    const rep = await buildReleaseReport({ client: fakeClient(), boardId: 1946, now: NOW, prefixes: ['POS_7', 'mpos_', 'CCL_8.'] });
    assert.deepEqual([...rep.active, ...rep.dormant, ...rep.complete].map((x) => x.name).sort(),
      ['CCL_8.886.22.10', 'MPOS_1.22.x', 'POS_7.45.0.29', 'POS_7.46.0.6'], 'case-insensitive starts-with; KDS, Madpay, OLO left out');
    assert.equal(rep.untrackedVersions, 3);
    assert.equal(rep.totals.inMoreThanOneVersion, 1, 'REST-3 has only one tracked version (OLO is untracked)');
    assert.ok(!rep.followUps.some((f) => /OLO|Madpay|KDS/.test(f.text)));
    assert.match(renderReleaseReport({ ...rep, followUpsSource: 'rules' }), /Tracking versions starting with POS_7, mpos_, CCL_8\. \(3 other unreleased version\(s\) with board work not shown\)\./);
  });

  test('product line from version names', () => {
    assert.deepEqual(['POS_7.46.0.6', 'MPOS_1.21.x', 'OLO 2.1.X', 'RA 2.0 - 2.2.2', 'CAKE NEO Release', 'Madpay_1.1.106'].map(productLine),
      ['POS', 'MPOS', 'OLO', 'RA', 'CAKE', 'Madpay']);
  });
});

test('runReport releases: snapshot by version name, next-day changes incl. date moves', async () => {
  const store = createStore(openDb(':memory:'));
  const config = { jira: { releaseWindowDays: 14 }, reports: { boardId: 1946, releaseActiveDays: 30 } };
  await runReport('releases', { client: fakeClient(), store, config, now: new Date('2026-11-04T14:00:00Z') });

  // REST-4 finished; MPOS_1.22.x re-dated (the version date is the same on every issue).
  const later = ISSUES.map((i) => (i.key === 'REST-4' ? issue('REST-4', '10002', [V.ccl]) : i))
    .map((i) => ({ ...i, fields: { ...i.fields, fixVersions: i.fields.fixVersions.map((v) => (v.id === V.mpos.id ? { ...v, releaseDate: '2026-11-20' } : v)) } }));
  const { report, markdown } = await runReport('releases', { client: fakeClient(later), store, config, now: NOW });
  const ccl = report.active.find((x) => x.name === 'CCL_8.886.22.10');
  assert.deepEqual(ccl.changes, { added: [], removed: [], newlyDone: ['REST-4'], newlyBlocked: [], moved: [], dateMoved: null });
  assert.deepEqual(report.active.find((x) => x.name === 'MPOS_1.22.x').changes.dateMoved, { from: '2026-11-12', to: '2026-11-20' });
  assert.match(markdown, /  - Since last report: done REST-4/);
  assert.equal(ccl.snapshot, undefined);
  assert.ok(store.lastReportSnapshot('releases', 1946).data.versions['Madpay_1.1.106'], 'snapshot keyed by version name');
});
