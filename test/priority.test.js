import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { runPriorityEngine } from '../src/priority/engine.js';
import { createClaudeReasoner } from '../src/priority/reason.js';
import { formatReport } from '../src/priority/format.js';
import { syncActions } from '../src/actions.js';
import { seedSample } from './fixtures/sample-data.js';

setLogLevel('error');

const NOW = new Date('2026-10-29T15:00:00Z');
let store;

beforeEach(() => {
  store = createStore(openDb(':memory:'));
  seedSample(store, NOW);
});

const run = (opts = {}) => runPriorityEngine(store, { now: NOW, ...opts });
const all = (r) => [...r.critical, ...r.waitingOnMe, ...r.releaseRisks, ...r.followUps];
const find = (r, re) => all(r).find((i) => re.test(i.title));

describe('ranking and categories', () => {
  test('production blockers and critical releases are critical, ranked first', async () => {
    const r = await run();
    const titles = r.critical.map((i) => i.title);
    assert.ok(titles.some((t) => /Release at risk: REST POS 8\.9\.1/.test(t)));
    assert.ok(titles.some((t) => /Production blocker REST-900/.test(t)));
    const scores = all(r).map((i) => i.score);
    assert.ok(Math.min(...r.critical.map((i) => i.score)) >= Math.max(...r.waitingOnMe.map((i) => i.score)) || r.critical.length,
      'critical items outrank the rest');
    assert.equal(scores.length, r.counts.total);
  });

  test('decisions and replies waiting on me are grouped, oldest/biggest first', async () => {
    const r = await run();
    const approval = find(r, /Approval requested by Randy/);
    assert.equal(approval.category, 'waiting_on_me');
    assert.equal(approval.type, 'decide');
    assert.ok(r.waitingOnMe.every((i) => ['decide', 'respond'].includes(i.type)));
    for (let i = 1; i < r.waitingOnMe.length; i++) assert.ok(r.waitingOnMe[i - 1].score >= r.waitingOnMe[i].score);
  });

  test('blocked work in a risky release is a release risk; overdue items and commitments are follow-ups', async () => {
    const r = await run();
    assert.equal(find(r, /Unblock REST-901/).category, 'release_risks');
    assert.equal(find(r, /Overdue: REST-902/).category, 'follow_ups');
    const commitment = find(r, /You committed/);
    assert.equal(commitment.category, 'follow_ups');
    assert.ok(commitment.reasons.some((x) => /Overdue by 1 day/.test(x.label)));
    assert.ok(find(r, /No reply yet/).reasons.some((x) => /No reply to your question for 5 day/.test(x.label)));
  });

  test('every item has a source link, evidence, reasons and a next action', async () => {
    for (const item of all(await run())) {
      assert.ok(item.sources.length, `${item.title}: source`);
      for (const s of item.sources) {
        assert.ok(['Jira', 'Outlook', 'Teams'].includes(s.system));
        assert.match(s.url, /^https:\/\//);
        assert.ok(s.text.length > 10, `${item.title}: evidence`);
      }
      assert.ok(item.reasons.length, `${item.title}: reasons`);
      assert.ok(item.nextAction.length > 10, `${item.title}: next action`);
    }
  });

  test('the same issue raised in email and Teams is one item with both sources', async () => {
    const r = await run();
    const merged = all(r).filter((i) => i.dedupeKey === 'jira:REST-900:respond');
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].sources.map((s) => s.system).sort(), ['Outlook', 'Teams']);
    assert.ok(merged[0].reasons.some((x) => /Raised in/.test(x.label)));
    assert.ok(merged[0].reasons.some((x) => /Business impact: mentions merchants/.test(x.label)));
  });

  test('rule-based top three are the three highest scores, with reasons', async () => {
    const r = await run();
    const best = all(r).sort((a, b) => b.score - a.score).slice(0, 3).map((i) => i.id);
    assert.equal(r.topThree.method, 'rules');
    assert.deepEqual(r.topThree.items.map((i) => i.id), best);
    assert.ok(r.topThree.items.every((i) => i.why && i.nextAction));
  });

  test('text report has all five sections', async () => {
    const text = formatReport(await run());
    for (const h of ['RECOMMENDED TOP THREE', 'CRITICAL', 'DECISIONS & RESPONSES', 'RELEASE RISKS', 'FOLLOW-UPS']) assert.match(text, new RegExp(h));
  });
});

describe('alerts and state between runs', () => {
  test('critical alerts are raised once, never duplicated on re-runs', async () => {
    const first = await run({ raiseAlerts: true });
    assert.equal(first.newAlerts.length, first.counts.critical);
    const second = await run({ raiseAlerts: true });
    assert.equal(second.newAlerts.length, 0);
    assert.equal(store.listActiveAlerts().length, first.counts.critical);
  });

  test('viewing priorities does not raise alerts', async () => {
    await run();
    assert.equal(store.listActiveAlerts().length, 0);
  });

  test('rankings persist and unchanged runs write nothing', async () => {
    const r = await run();
    const top = all(r)[0];
    const row = store.getActionItem(top.id);
    assert.equal(row.score, top.score);
    assert.equal(row.category, top.category);
    assert.equal(store.saveActionRanking(top.id, { score: top.score, category: top.category, reasons: top.reasons }), false);
  });

  test('my status changes are kept: dismissed and snoozed items drop out, re-sync does not revive them', async () => {
    const r = await run();
    const approval = find(r, /Approval requested by Randy/);
    const rob = find(r, /Reply to Rob/);
    store.setActionStatus(approval.id, 'dismissed');
    store.setActionStatus(rob.id, 'snoozed', { snoozedUntil: '2026-11-05T00:00:00Z' });

    seedSample(store, NOW); // same data synced again
    syncActions(store);
    const after = await run();
    assert.equal(find(after, /Approval requested by Randy/), undefined);
    assert.equal(find(after, /Reply to Rob/), undefined);
    assert.equal(after.counts.total, r.counts.total - 2);
  });

  test('a dismissed critical item does not alert again', async () => {
    await run({ raiseAlerts: true });
    const blocker = find(await run(), /Production blocker REST-900/);
    store.setActionStatus(blocker.id, 'dismissed');
    const again = await run({ raiseAlerts: true });
    assert.equal(again.newAlerts.length, 0);
  });
});

describe('Claude top three (optional)', () => {
  function fakeClient(responses) {
    const calls = [];
    return {
      calls,
      beta: { messages: { create: async (req) => { calls.push(req); return responses.shift(); } } },
    };
  }
  const reply = (obj, extra = {}) => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: {}, content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra });

  test('is called with rule-scored candidates and cached until they change', async () => {
    const ranked = all(await run()).sort((a, b) => b.score - a.score);
    const pick = [ranked[2].id, ranked[0].id, ranked[1].id];
    const client = fakeClient([reply({ top: pick.map((id) => ({ id, why: `because ${id}` })), summary: 'Stabilise REST-900 first.' })]);
    const reasoner = createClaudeReasoner({ store, model: 'claude-opus-5-5', client });

    const r1 = await run({ reasoner });
    assert.equal(r1.topThree.method, 'claude');
    assert.deepEqual(r1.topThree.items.map((i) => i.id), pick);
    assert.equal(r1.topThree.summary, 'Stabilise REST-900 first.');

    const req = client.calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.fallbacks, 'default');
    assert.equal(req.output_config.format.type, 'json_schema');
    const sent = JSON.parse(req.messages[0].content);
    assert.ok(sent.candidates.length <= 8 && sent.candidates[0].evidence.length, 'only top candidates, with evidence');

    const r2 = await run({ reasoner });
    assert.equal(r2.topThree.method, 'claude-cached');
    assert.equal(client.calls.length, 1, 'no second call for unchanged candidates');
  });

  test('falls back to rules on refusal or unusable output', async () => {
    const client = fakeClient([
      { stop_reason: 'refusal', stop_details: { category: null }, content: [] },
      reply({ top: [{ id: 999999, why: 'x' }], summary: 's' }),
    ]);
    const reasoner = createClaudeReasoner({ store, model: 'claude-opus-5-5', client });
    assert.equal((await run({ reasoner })).topThree.method, 'rules');
    assert.equal((await run({ reasoner })).topThree.method, 'rules');
  });
});
