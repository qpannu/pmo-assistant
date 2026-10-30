import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProdReport, renderProdReport, prodChanges, prodJql } from '../src/reports/prod.js';
import { runReport } from '../src/reports/index.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const NOW = new Date('2026-11-05T12:00:00Z');
const S = {
  open: { id: '1', name: 'Open', statusCategory: { key: 'new' } },
  code: { id: '10006', name: 'Code Review', statusCategory: { key: 'indeterminate' } },
  rqa: { id: '10007', name: 'Ready for QA', statusCategory: { key: 'new' } },
  pmr: { id: '10498', name: 'Pending Merchant Review', statusCategory: { key: 'indeterminate' } },
  blocked: { id: '10051', name: 'Blocked', statusCategory: { key: 'new' } },
  rejected: { id: '7', name: 'Rejected', statusCategory: { key: 'done' } },
};
const day = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function prb(key, status, { team = 'Tesla', severity = 'Medium', priority = 'Unprioritized', owner = 'Ann', created = 20, updated = 1, comps = ['CAKE POS 3350'], resolved = null, resolution = null, links = [] } = {}) {
  return {
    key,
    fields: {
      summary: `Problem ${key}`, status, issuetype: { name: 'PROD_PRB' }, priority: { name: priority },
      assignee: owner ? { accountId: owner, displayName: owner } : null, components: comps.map((name) => ({ name })),
      fixVersions: [], issuelinks: links, labels: [], created: day(created), updated: day(updated),
      resolutiondate: resolved != null ? day(resolved) : null, resolution: resolution ? { name: resolution } : null,
      customfield_10153: { value: team }, customfield_10036: severity ? { value: severity } : null, customfield_10021: null,
    },
  };
}

const OPEN = [
  prb('REST-1', S.open, { severity: 'Critical', owner: null, created: 3, updated: 2 }),        // new, critical, no owner
  prb('REST-2', S.rqa, { severity: 'Critical', priority: 'High', created: 10, updated: 1 }),   // critical, in QA
  prb('REST-3', S.code, { severity: 'High', created: 60, updated: 20, owner: 'Bo' }),          // stalled high
  prb('REST-4', S.pmr, { severity: 'High', created: 150, updated: 120 }),                      // waiting long
  prb('REST-5', S.pmr, { severity: 'Medium', created: 40, updated: 10 }),                      // waiting, recent
  prb('REST-6', S.blocked, { severity: 'Medium', created: 35, updated: 30, owner: 'Bo' }),     // blocked (not "stalled")
  prb('REST-7', S.open, { severity: null, priority: 'High', created: 5, updated: 5, comps: [] }), // urgent by priority only
  prb('REST-8', S.open, { team: 'Mira', severity: 'Critical' }),                                // other team — must not count
];
const RESOLVED = [prb('REST-9', S.rejected, { created: 60, resolved: 2, resolution: "Won't Do" })];

const FIELDS = [
  { id: 'customfield_10153', name: 'Team', custom: true, schema: { type: 'option' }, clauseNames: ['Team[Dropdown]', 'cf[10153]'] },
  { id: 'customfield_10001', name: 'Team', custom: true, schema: { type: 'team' }, clauseNames: ['Team[Team]', 'cf[10001]'] },
  { id: 'customfield_10036', name: 'Severity', custom: true }, { id: 'customfield_10266', name: 'Severityy', custom: true },
  { id: 'customfield_10021', name: 'Flagged', custom: true },
];

function fakeClient(open = OPEN, resolved = RESOLVED) {
  const searches = [];
  return {
    searches,
    fields: async () => FIELDS,
    search: async ({ jql }) => { searches.push(jql); return { issues: jql.includes('statusCategory = Done') ? resolved : open, truncated: false }; },
    browseUrl: (k) => `https://jira.example/browse/${k}`,
  };
}
const SCOPE = { project: 'REST', issueType: 'PROD_PRB', team: 'Tesla', waitingStatuses: ['Pending Merchant Review'] };

describe('production issues report', () => {
  test('scope uses the Team dropdown (not the Atlassian Team field) and re-checks every issue', async () => {
    const client = fakeClient();
    const rep = await buildProdReport({ client, scope: SCOPE, now: NOW });
    assert.equal(prodJql(SCOPE, 'customfield_10153'), 'project = "REST" AND issuetype = "PROD_PRB" AND cf[10153] = "Tesla"');
    assert.deepEqual(client.searches, [
      'project = "REST" AND issuetype = "PROD_PRB" AND cf[10153] = "Tesla" AND statusCategory != Done ORDER BY created ASC',
      'project = "REST" AND issuetype = "PROD_PRB" AND cf[10153] = "Tesla" AND statusCategory = Done AND statusCategoryChangedDate >= -7d ORDER BY statusCategoryChangedDate DESC',
    ]);
    assert.deepEqual(rep.warnings, ['1 open issue(s) had a different team value and were left out: REST-8']);
    assert.equal(rep.totals.open, 7);
  });

  test('facts: totals, severity, aging, waiting vs engineering, blocked, stalled, owners, resolved', async () => {
    const rep = await buildProdReport({ client: fakeClient(), scope: SCOPE, now: NOW });
    assert.deepEqual(rep.totals, { open: 7, withEngineering: 5, waiting: 2, urgent: 5, urgentWithEngineering: 4, new: 2, resolved: 1, blocked: 1, stalled: 1, longWait: 1, unowned: 1 });
    assert.deepEqual(rep.bySeverity, { Critical: 2, High: 2, Medium: 2, '(no severity)': 1 });
    assert.deepEqual(rep.aging.map((a) => [a.label, a.all, a.urgent]), [['0–7 days', 2, 2], ['8–30 days', 1, 1], ['31–90 days', 3, 1], ['over 90 days', 1, 1]]);
    // Critical (oldest first), then High severity (engineering before waiting), then High by priority only.
    assert.deepEqual(rep.urgent.map((i) => i.key), ['REST-2', 'REST-1', 'REST-3', 'REST-4', 'REST-7']);
    assert.deepEqual(rep.blocked.map((b) => [b.key, b.why]), [['REST-6', ['status Blocked']]]);
    assert.deepEqual(rep.stalled.map((i) => i.key), ['REST-3'], 'blocked issues are not double-counted as stalled');
    assert.deepEqual(rep.longWait.map((i) => [i.key, i.idleDays]), [['REST-4', 120]]);
    assert.deepEqual(rep.resolved.map((i) => [i.key, i.status, i.resolution, i.daysToResolve]), [['REST-9', 'Rejected', "Won't Do", 58]]);
  });

  test('inferred risks and follow-ups; fixes already in QA ask for a verification date, not a fix ETA', async () => {
    const rep = await buildProdReport({ client: fakeClient(), scope: SCOPE, now: NOW });
    assert.deepEqual(rep.risks, [
      '1 critical/high issue(s) with engineering and no update in 14+ days',
      '1 critical/high issue(s) with no owner',
      '1 issue(s) waiting outside engineering for 30+ days',
      'more new (2) than resolved (1) in the last 7 days',
      '3 critical/high-severity issue(s) still "Unprioritized"',
    ]);
    const texts = rep.followUps.map((f) => f.text);
    assert.match(texts[0], /^Confirm when the fix for Critical REST-2 from Ann will be verified and released — Ready for QA/);
    assert.match(texts[1], /^Get a fix ETA on Critical REST-1 from an owner \(none assigned\) — Open, open 3 d/);
    assert.ok(texts.some((t) => /^Chase or close 1 issue\(s\) waiting 30\+ days \(Pending Merchant Review\), oldest first: REST-4$/.test(t)));
    assert.ok(texts.some((t) => /^Ask for a priority on 3 critical\/high-severity issue\(s\) marked "Unprioritized": REST-1, REST-3, REST-4$/.test(t)));
  });

  test('ownership concentration is flagged when one person holds a large share', async () => {
    const many = Array.from({ length: 10 }, (_, i) => prb(`REST-${100 + i}`, S.open, { owner: i < 5 ? 'Sam' : `P${i}` }));
    const rep = await buildProdReport({ client: fakeClient(many, []), scope: SCOPE, now: NOW });
    assert.deepEqual(rep.concentrated, [{ name: 'Sam', open: 5, share: 50 }]);
  });

  test('markdown: facts, waiting split, inferred section, no tables', async () => {
    const md = renderProdReport({ ...(await buildProdReport({ client: fakeClient(), scope: SCOPE, now: NOW })), followUpsSource: 'rules' });
    assert.match(md, /Scope: PROD_PRB in REST where Team = Tesla \(each issue's team re-checked\)\./);
    assert.match(md, /- \*\*7 open\*\*: 5 with engineering · 2 waiting \(Pending Merchant Review\)/);
    assert.match(md, /\*\*Critical and high — with engineering\*\* \(4\)/);
    assert.match(md, /\*\*Critical and high — waiting\*\* \(1\)/);
    assert.ok(md.indexOf('**Facts (from Jira)**') < md.indexOf('**⚠️ Inferred (rules, not Jira facts)**'));
    assert.doesNotMatch(md, /\|/);
  });
});

test('changes since last report: new, resolved, severity / status / owner moves', () => {
  const c = prodChanges(
    { A: ['todo', 'High', 'Ann', 'Open'], B: ['review', 'Medium', 'Bo', 'Ready for QA'], C: ['todo', 'Low', null, 'Open'] },
    { A: ['review', 'Critical', 'Cy', 'Code Review'], D: ['todo', 'High', null, 'Open'] },
    ['B'],
  );
  assert.deepEqual(c, {
    added: ['D'], resolved: ['B'], leftOther: ['C'],
    severity: [{ key: 'A', from: 'High', to: 'Critical' }], status: [{ key: 'A', from: 'Open', to: 'Code Review' }], owner: [{ key: 'A', from: 'Ann', to: 'Cy' }],
  });
});

test('runReport prod: needs settings; snapshots by scope; next-day changes', async () => {
  const store = createStore(openDb(':memory:'));
  const config = (p) => ({ reports: { boardId: 0, prod: { waitingStatuses: ['Pending Merchant Review'], staleDays: 14, waitingDays: 30, ...p } } });
  await assert.rejects(runReport('prod', { client: fakeClient(), store, config: config({}) }), /Set REPORT_PROD_PROJECT, REPORT_PROD_ISSUE_TYPE, REPORT_PROD_TEAM in \.env/);

  const cfg = config({ project: 'REST', issueType: 'PROD_PRB', team: 'Tesla' });
  await runReport('prod', { client: fakeClient(), store, config: cfg, now: new Date('2026-11-04T14:00:00Z') });
  const later = OPEN.filter((i) => i.key !== 'REST-2').concat(prb('REST-20', S.open, { severity: 'High', created: 0 }));
  const { report, markdown } = await runReport('prod', { client: fakeClient(later, [prb('REST-2', S.rejected, { resolved: 0 })]), store, config: cfg, now: NOW });
  assert.deepEqual([report.changes.added, report.changes.resolved], [['REST-20'], ['REST-2']]);
  assert.match(markdown, /\*\*Since last report\*\*\n- new: REST-20\n- resolved: REST-2/);
  assert.ok(store.lastReportSnapshot('prod', 'REST:PROD_PRB:Tesla'));
  assert.equal(report.snapshot, undefined);
});
