import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeFacts, riskIdentity, applyLearning, loadLearningRules, recurringBlockers, reopened, followUpLine, learningLines, DEFAULT_RULES,
} from '../src/reports/learning.js';
import { setVerdict, recentRisks } from '../src/reports/feedback.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const DAY1 = new Date('2026-11-02T12:00:00Z');
const DAY2 = new Date('2026-11-03T12:00:00Z');
const fu = (rule, keys, text) => ({ rule, keys, text });
const LIST = (age = 3) => [
  fu('blocker', ['REST-3'], 'Unblock REST-3 (Cy): status Blocked'),
  fu('no-owner', ['REST-4'], 'Assign owners to 1 issue(s): REST-4'),
  fu('stale', ['REST-6'], `Check in on REST-6 — no update in ${age} days`),
  fu('unestimated', [], '1 open issue(s) have no story points'),
];
const newStore = () => createStore(openDb(':memory:'));

describe('identity and fingerprints', () => {
  test('time-passing figures do not change the facts; counts, dates and keys do', () => {
    assert.equal(normalizeFacts('open 7 d, last update 2 d ago, idle 49d, 3 day(s) ago, in 5 working days'), 'open #d, last update #d ago, idle #d, #d ago, in #d');
    const a = riskIdentity('scrum', fu('stale', ['REST-6'], 'Check in on REST-6 — no update in 3 days'));
    const b = riskIdentity('scrum', fu('stale', ['REST-6'], 'Check in on REST-6 — no update in 4 days'));
    const c = riskIdentity('releases', fu('date-passed', [], 'Decide on CCL_8.886.22.10: target 2026-11-01 with 2 open'));
    const d = riskIdentity('releases', fu('date-passed', [], 'Decide on CCL_8.886.22.10: target 2026-11-20 with 2 open'));
    assert.deepEqual([a.ref, a.fingerprint], [b.ref, b.fingerprint], 'same issue, a day older → same facts');
    assert.notEqual(c.fingerprint, d.fingerprint, 're-dated → facts changed');
    assert.match(a.ref, /^[0-9a-f]{6}$/);
    assert.notEqual(riskIdentity('scrum', fu('stale', ['REST-7'], 'x')).ref, a.ref, 'different issue → different ref');
  });

  test('a follow-up about a group keeps its ref when members change; the change shows as new facts', () => {
    const g1 = riskIdentity('prod', fu('long-wait', ['REST-1', 'REST-2', 'REST-3'], 'Chase or close 3 issue(s): REST-1, REST-2, REST-3'));
    const g2 = riskIdentity('prod', fu('long-wait', ['REST-1', 'REST-2', 'REST-4'], 'Chase or close 3 issue(s): REST-1, REST-2, REST-4'));
    assert.equal(g1.ref, g2.ref);
    assert.notEqual(g1.fingerprint, g2.fingerprint);
    const i1 = riskIdentity('features', { rule: 'epic-overdue', keys: ['REST-17834', 'REST-1', 'REST-2'], subject: 'REST-17834', text: 'x' });
    const i2 = riskIdentity('features', { rule: 'epic-overdue', keys: ['REST-247', 'REST-1', 'REST-2'], subject: 'REST-247', text: 'x' });
    assert.notEqual(i1.ref, i2.ref, 'one identity per initiative');
  });
});

describe('applyLearning', () => {
  test('first run: everything is new and ranked by rule weight', () => {
    const store = newStore();
    const out = applyLearning({ store, report: 'scrum', followUps: LIST(), now: DAY1 });
    assert.deepEqual(out.followUps.map((f) => [f.rule, f.status, f.score]), [['blocker', 'new', 80], ['stale', 'new', 50], ['no-owner', 'new', 45], ['unestimated', 'new', 10]]);
    assert.deepEqual([out.unchanged, out.suppressed, out.disabled, out.penalised], [[], [], [], []]);
    assert.equal(recentRisks(store, { now: DAY1 }).length, 4);
  });

  test('next day: unchanged repeats collapse, urgent ones still show; changed facts are flagged', () => {
    const store = newStore();
    applyLearning({ store, report: 'scrum', followUps: LIST(3), now: DAY1 });
    const list = LIST(4);
    list[1] = fu('no-owner', ['REST-4'], 'Assign owners to 2 issue(s): REST-4, REST-9'); // keys same id? no — keys changed
    list[1].keys = ['REST-4'];
    const out = applyLearning({ store, report: 'scrum', followUps: list, now: DAY2 });
    assert.deepEqual(out.followUps.map((f) => [f.rule, f.status]), [['blocker', 'unchanged'], ['no-owner', 'changed']], 'blocker ≥ alwaysShowScore stays visible');
    assert.deepEqual(out.unchanged.map((f) => f.rule), ['stale', 'unestimated']);
    assert.ok(out.followUps[0].why.some((w) => /raised on 1 earlier day\(s\) since 2026-11-02/.test(w)));
  });

  test('dismissed stays hidden until its facts change; resolved and valid add notes; valid ranks higher', () => {
    const store = newStore();
    const first = applyLearning({ store, report: 'scrum', followUps: LIST(), now: DAY1 }).followUps;
    const ref = (rule) => first.find((f) => f.rule === rule).ref;
    setVerdict(store, ref('blocker'), 'dismissed', 'known — vendor fix');
    setVerdict(store, ref('no-owner'), 'resolved');
    setVerdict(store, `#${ref('unestimated')}`, 'valid');

    const out = applyLearning({ store, report: 'scrum', followUps: LIST(), now: DAY2 });
    assert.deepEqual(out.suppressed.map((f) => f.ref), [ref('blocker')]);
    const byRule = Object.fromEntries(out.followUps.map((f) => [f.rule, f]));
    assert.match(byRule['no-owner'].note, /you marked this resolved on \d{4}-\d{2}-\d{2}, but Jira still shows it/);
    assert.match(byRule.unestimated.note, /^✔ confirmed/);
    assert.equal(byRule.unestimated.score, 10 + 2 + 30, 'weight + repeat + valid boost');

    const changed = LIST();
    changed[0] = fu('blocker', ['REST-3'], 'Unblock REST-3 (Cy): status Blocked; blocked by REST-50 (Open)');
    const again = applyLearning({ store, report: 'scrum', followUps: changed, now: new Date('2026-11-04T12:00:00Z') });
    assert.match(again.followUps.find((f) => f.rule === 'blocker').note, /you dismissed this on .*; the facts have changed since/);
  });

  test('rules you mostly dismiss rank lower, and the report says so', () => {
    const store = newStore();
    const many = ['REST-1', 'REST-2', 'REST-3'].map((k) => fu('no-owner', [k], `Assign an owner to ${k}`));
    for (const f of applyLearning({ store, report: 'prod', followUps: many, now: DAY1 }).followUps) setVerdict(store, f.ref, 'dismissed');
    const out = applyLearning({ store, report: 'prod', followUps: [fu('no-owner', ['REST-9'], 'Assign an owner to REST-9')], now: DAY2 });
    assert.deepEqual(out.penalised, ['no-owner']);
    assert.equal(out.followUps[0].score, 45 - 20);
    assert.ok(out.followUps[0].why.includes('you usually dismiss this kind'));
  });

  test('rules file can switch rules off (bare or per report) and re-weight them', () => {
    const store = newStore();
    const rules = { ...DEFAULT_RULES, disabled: ['unestimated', 'scrum:no-owner'], weights: { ...DEFAULT_RULES.weights, stale: 99 } };
    const out = applyLearning({ store, report: 'scrum', followUps: LIST(), rules, now: DAY1 });
    assert.deepEqual(out.followUps.map((f) => f.rule), ['stale', 'blocker']);
    assert.deepEqual(out.disabled.map((f) => f.rule), ['no-owner', 'unestimated']);
    const prod = applyLearning({ store, report: 'prod', followUps: [fu('no-owner', ['REST-4'], 'x')], rules, now: DAY1 });
    assert.equal(prod.followUps.length, 1, '"scrum:no-owner" only switches it off for scrum');
  });

  test('save: false reads feedback but records nothing', () => {
    const store = newStore();
    applyLearning({ store, report: 'scrum', followUps: LIST(), now: DAY1, save: false });
    assert.equal(recentRisks(store, { now: DAY1 }).length, 0);
  });

  test('loadLearningRules: defaults, overrides, and a bad file is reported not fatal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmo-rules-'));
    try {
      assert.equal(loadLearningRules(join(dir, 'missing.json')).source, 'defaults');
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({ weights: { blocker: 5 }, disabled: ['dormant'], collapseUnchanged: false }));
      const ok = loadLearningRules(join(dir, 'ok.json'));
      assert.deepEqual([ok.weights.blocker, ok.weights.critical, ok.disabled, ok.collapseUnchanged], [5, 95, ['dormant'], false]);
      writeFileSync(join(dir, 'bad.json'), '{ nope');
      const bad = loadLearningRules(join(dir, 'bad.json'));
      assert.equal(bad.source, 'defaults');
      assert.match(bad.error, /bad\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history: recurring blockers and reopened issues', () => {
  const snap = (store, report, scope, at, data) => store.saveReportSnapshot(report, scope, data, at);
  const scrumData = (phases) => ({ sprints: { 77: { name: 'S', issues: Object.fromEntries(Object.entries(phases).map(([k, p]) => [k, [p, 3, 'Ann']])) } } });

  test('blocked again after being unblocked, or blocked many days, is recurring; one snapshot per day counts', () => {
    const store = newStore();
    const days = [
      { 'REST-1': 'blocked', 'REST-2': 'blocked', 'REST-3': 'inProgress' },
      { 'REST-1': 'inProgress', 'REST-2': 'blocked', 'REST-3': 'blocked' },
      { 'REST-1': 'blocked', 'REST-2': 'blocked', 'REST-3': 'inProgress' },
      { 'REST-1': 'blocked', 'REST-2': 'blocked', 'REST-3': 'done' },
      { 'REST-1': 'review', 'REST-2': 'blocked' },
    ];
    days.forEach((d, i) => {
      snap(store, 'scrum', 1946, `2026-11-0${i + 1}T08:00:00.000Z`, scrumData({ 'REST-2': 'inProgress' })); // earlier same-day run is ignored
      snap(store, 'scrum', 1946, `2026-11-0${i + 1}T12:00:00.000Z`, scrumData(d));
    });
    const r = recurringBlockers({ store, report: 'scrum', scope: 1946, now: new Date('2026-11-05T13:00:00Z'), rules: DEFAULT_RULES });
    assert.deepEqual(r, [
      { key: 'REST-1', episodes: 2, blockedDays: 3, current: false },
      { key: 'REST-2', episodes: 1, blockedDays: 5, current: true },
    ]);
  });

  test('reopened: a key that left an earlier snapshot and is open again', () => {
    const store = newStore();
    const prodData = (keys) => ({ issues: Object.fromEntries(keys.map((k) => [k, ['todo', 'High', 'Ann', 'Open']])) });
    snap(store, 'prod', 'S', '2026-11-01T12:00:00.000Z', prodData(['REST-1', 'REST-2']));
    snap(store, 'prod', 'S', '2026-11-02T12:00:00.000Z', prodData(['REST-2']));
    assert.deepEqual(reopened({ store, report: 'prod', scope: 'S', keys: ['REST-1', 'REST-9'], now: new Date('2026-11-03T12:00:00Z') }), ['REST-1']);
  });
});

describe('rendering and feedback commands', () => {
  test('follow-up lines carry new/changed markers, notes and refs; the learning block explains itself', () => {
    assert.equal(followUpLine({ text: 'Unblock REST-3', status: 'new', ref: 'abc123' }), '- 🆕 Unblock REST-3 · ref abc123');
    assert.equal(followUpLine({ text: 'Unblock REST-3', status: 'unchanged', note: '✔ confirmed 2026-11-02', ref: 'abc123' }), '- Unblock REST-3 — ✔ confirmed 2026-11-02 · ref abc123');
    const lines = learningLines(
      { unchanged: [{ keys: ['REST-6'], rule: 'stale', firstSeen: '2026-11-02T12:00:00Z', ref: 'aaa111' }], suppressed: [{ ref: 'bbb222' }], disabled: [{ rule: 'unestimated' }], penalised: ['no-owner'] },
      { recurring: [{ key: 'REST-1', episodes: 2, blockedDays: 3, current: true }] },
    ).join('\n');
    assert.match(lines, /\*\*🧠 From past reports and your feedback\*\*/);
    assert.match(lines, /Still open, unchanged since last report \(1\): REST-6 \(stale, since 2026-11-02, ref aaa111\)/);
    assert.match(lines, /Hidden because you dismissed them and nothing changed \(1\): ref bbb222/);
    assert.match(lines, /Switched off in the rules file: unestimated/);
    assert.match(lines, /Ranked lower because you usually dismiss them: no-owner/);
    assert.match(lines, /🔁 Recurring blockers \(last 30 days\): REST-1 \(blocked 2 times, blocked now\)/);
    assert.doesNotMatch(lines, /\|/);
  });

  test('setVerdict validates input and records history; clear forgets', () => {
    const store = newStore();
    const [f] = applyLearning({ store, report: 'scrum', followUps: LIST().slice(0, 1), now: DAY1 }).followUps;
    assert.throws(() => setVerdict(store, f.ref, 'maybe'), /valid, dismissed, resolved or clear/);
    assert.throws(() => setVerdict(store, 'ffffff', 'valid'), /No reported risk with ref ffffff/);
    assert.equal(setVerdict(store, f.ref, 'dismissed', 'dup of REST-1').verdict_note, 'dup of REST-1');
    assert.equal(setVerdict(store, f.ref, 'clear').verdict, null);
    assert.deepEqual(store.listHistory('risk', f.ref).map((h) => h.event), ['verdict:dismissed', 'verdict:cleared']);
  });

  test('GET /risks and POST /risks/:ref', async () => {
    const db = openDb(':memory:');
    const store = createStore(db);
    const [f] = applyLearning({ store, report: 'scrum', followUps: LIST().slice(0, 1), now: new Date() }).followUps;
    const scheduler = createScheduler();
    const server = createApp(loadConfig(), { db, store, scheduler }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await (await fetch(`${url}/risks?report=scrum`)).json())[0].ref, f.ref);
      assert.equal((await fetch(`${url}/risks/${f.ref}`, { method: 'POST', body: 'verdict=valid' })).status, 415);
      const ok = await fetch(`${url}/risks/${f.ref}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'valid', note: 'yes' }) });
      assert.equal((await ok.json()).verdict, 'valid');
      const bad = await fetch(`${url}/risks/zzzzzz`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'valid' }) });
      assert.equal(bad.status, 404);
    } finally {
      server.close();
      scheduler.stop();
    }
  });
});

test('a follow-up seen several times in one day counts once (dashboard refreshes do not inflate it)', () => {
  const store = createStore(openDb(':memory:'));
  const f = [{ rule: 'blocker', keys: ['REST-3'], text: 'Unblock REST-3' }];
  for (const hour of ['09', '11', '15']) applyLearning({ store, report: 'scrum', followUps: f, now: new Date(`2026-11-02T${hour}:00:00Z`) });
  applyLearning({ store, report: 'scrum', followUps: f, now: new Date('2026-11-03T09:00:00Z') });
  assert.equal(store.listRiskItems()[0].times_seen, 2);
});

test('re-running the same day gives no repeat boost; a new day does', () => {
  const store = createStore(openDb(':memory:'));
  const f = [{ rule: 'stale', keys: ['REST-6'], text: 'Check in on REST-6' }];
  applyLearning({ store, report: 'scrum', followUps: f, now: new Date('2026-11-02T09:00:00Z') });
  const same = applyLearning({ store, report: 'scrum', followUps: f, now: new Date('2026-11-02T15:00:00Z'), rules: { ...DEFAULT_RULES, collapseUnchanged: false } });
  assert.deepEqual([same.followUps[0].score, same.followUps[0].why], [50, ['rule stale (50)']]);
  const next = applyLearning({ store, report: 'scrum', followUps: f, now: new Date('2026-11-03T09:00:00Z'), rules: { ...DEFAULT_RULES, collapseUnchanged: false } });
  assert.equal(next.followUps[0].score, 52);
});
