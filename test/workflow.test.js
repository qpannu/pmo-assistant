// End-to-end workflow with the real modules, an in-memory database, the
// fictional sample data, a fake Claude client and a fake Teams webhook.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { setLogLevel } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { createScheduler } from '../src/scheduler.js';
import { createClaude } from '../src/claude/client.js';
import { createTeamsNotifier, notifyPendingAlerts } from '../src/notify/teams.js';
import { createBriefingService } from '../src/briefing/briefing.js';
import { dayKey } from '../src/time.js';

import { seedSample } from './fixtures/sample-data.js';

setLogLevel('error');

const WEBHOOK = 'https://example.webhook.office.com/workflows/abc?sig=secret';

function fakeClaude() {
  const calls = [];
  const client = {
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          const user = req.messages[0].content;
          let text;
          if (req.output_config.format) text = JSON.stringify({ subject: 'Re: POS 7.45.0.29 hotfix — Go/No-Go', body: 'Hi Randy,\n\nApproved — go ahead tonight. [confirm rollback owner]\n\nThanks' });
          else if (/morning briefing/i.test(user)) text = '**Top 3 today**\n- Release POS 8.9.1 is overdue — run a go/no-go.';
          else if (/midday update/i.test(user)) text = '**Midday**\n- One new item.';
          else if (/end-of-day/i.test(user)) text = '**Closed today**\n- Approval for hotfix.';
          else text = 'REST-900 is the production blocker; Ben owns it and has no ETA yet.';
          return { stop_reason: 'end_turn', model: req.model, usage: { input_tokens: 900, output_tokens: 120 }, content: [{ type: 'text', text }] };
        },
      },
    },
  };
  return { client, calls };
}

function fakeWebhook({ failTimes = 0 } = {}) {
  const posts = [];
  let failures = failTimes;
  const fetchImpl = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    if (failures > 0) { failures--; return { ok: false, status: 503 }; }
    return { ok: true, status: 202 };
  };
  return { fetchImpl, posts };
}

const cardTitle = (post) => post.body.attachments[0].content.body[0].text;

let store, claudeFake, hook, claude, notifier, briefings, base, server;

async function setup({ failTimes = 0, dailyCallLimit = 40 } = {}) {
  store = createStore(openDb(':memory:'));
  seedSample(store);
  claudeFake = fakeClaude();
  hook = fakeWebhook({ failTimes });
  claude = createClaude({ store, model: 'claude-opus-5-5', client: claudeFake.client, dailyCallLimit });
  notifier = createTeamsNotifier({ webhookUrl: WEBHOOK, fetchImpl: hook.fetchImpl, retryDelayMs: 1 });
  briefings = createBriefingService({ store, claude, notifier });
  const config = { ...loadConfig(), claudeDailyCallLimit: dailyCallLimit, myName: 'Pat' };
  server = createApp(config, { store, scheduler: createScheduler(), notifier, claude, briefings }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const post = (path, body = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('complete workflow', () => {
  beforeEach(async () => {
    server?.close();
    await setup();
  });

  test('urgent alerts reach Teams once, with links to the sources', async () => {
    const run = await (await post('/priorities/run')).json();
    assert.equal(run.newAlerts.length, 3);
    assert.equal((await notifyPendingAlerts(store, notifier)).length, 3);
    assert.equal(hook.posts.length, 3);
    assert.match(cardTitle(hook.posts[0]), /^🔴 Urgent: /);
    assert.ok(hook.posts[0].body.attachments[0].content.actions[0].url.startsWith('https://'));
    assert.ok(hook.posts.every((p) => p.url === WEBHOOK), 'only the webhook is ever called');

    await post('/priorities/run');
    assert.equal((await notifyPendingAlerts(store, notifier)).length, 0, 'no duplicate alerts');
    assert.equal(hook.posts.length, 3);
  });

  test('morning briefing: one Claude call with compact context, delivered once', async () => {
    const r = await (await post('/briefings/morning/run')).json();
    assert.equal(r.sent, true);
    assert.equal(r.method, 'claude');
    assert.equal(claudeFake.calls.length, 1);

    const req = claudeFake.calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.output_config.effort, 'medium');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.system.at(-1).cache_control, { type: 'ephemeral' }, 'stable prefix marked for caching');
    const data = JSON.parse(req.messages[0].content.split('Data:\n')[1]);
    assert.equal(data.priorities.length, 3);
    assert.ok(data.projects.length && data.releases.length, 'cross-project rollup and releases');
    assert.equal(data.meetings.available, false, 'missing calendar is reported, not guessed');
    assert.ok(!req.messages[0].content.includes('https://'), 'links sent as short ids, not URLs');
    assert.ok(req.messages[0].content.length < 9000, 'concise context');

    assert.match(cardTitle(hook.posts.at(-1)), /Morning briefing/);
    const again = await (await post('/briefings/morning/run')).json();
    assert.equal(again.skipped, 'already sent');
    assert.equal(claudeFake.calls.length, 1);
  });

  test('midday with no changes is sent without calling Claude; end of day reports what closed', async () => {
    await post('/briefings/morning/run');
    const midday = await (await post('/briefings/midday/run')).json();
    assert.equal(midday.method, 'unchanged');
    assert.match(midday.content, /No changes since the morning briefing/);
    assert.equal(claudeFake.calls.length, 1, 'only the morning call');

    const approval = (await (await fetch(`${base}/actions`)).json()).actions.find((a) => /Approval requested by Randy/.test(a.title));
    await post(`/actions/${approval.id}/status`, { status: 'done' });

    const eod = await (await post('/briefings/eod/run')).json();
    assert.equal(eod.method, 'claude');
    const data = JSON.parse(claudeFake.calls.at(-1).messages[0].content.split('Data:\n')[1]);
    assert.ok(data.changesToday.closed.some((c) => /Randy/.test(c.title)));
    assert.equal(claudeFake.calls.at(-1).output_config.effort, 'low');
  });

  test('questions get an answer from the relevant records only', async () => {
    const r = await (await post('/ask', { question: "What's the status of REST-900?" })).json();
    assert.equal(r.method, 'claude');
    assert.match(r.answer, /REST-900/);
    const sent = claudeFake.calls[0].messages[0].content;
    assert.match(sent, /REST-900/);
    assert.ok(r.references.length && r.references.every((x) => x.url));
    assert.equal((await post('/ask', {})).status, 400);
  });

  test('drafts need approval; nothing is sent; you mark it sent yourself', async () => {
    const approval = (await (await fetch(`${base}/actions`)).json()).actions.find((a) => /Approval requested by Randy/.test(a.title));
    const postsBefore = hook.posts.length;

    const created = await post(`/actions/${approval.id}/draft`, { channel: 'email', guidance: 'Approve, ask who owns rollback' });
    assert.equal(created.status, 201);
    const { draft, note } = await created.json();
    assert.equal(draft.status, 'pending');
    assert.equal(draft.target.address, 'randy@example.com');
    assert.match(draft.body, /Approved/);
    assert.match(note, /Nothing has been sent/);
    assert.ok(claudeFake.calls[0].output_config.format, 'structured subject/body');

    assert.equal((await post(`/drafts/${draft.id}/sent`)).status, 409, 'cannot skip approval');
    const edited = await (await fetch(`${base}/drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Approved. Thanks!' }) })).json();
    assert.equal(edited.body, 'Approved. Thanks!');

    const approved = await (await post(`/drafts/${draft.id}/approve`)).json();
    assert.equal(approved.draft.status, 'approved');
    const compose = approved.sendYourself.find((l) => /outlook\.office\.com\/mail\/deeplink\/compose/.test(l.url));
    assert.match(compose.url, /to=randy%40example\.com/);

    const sent = await (await post(`/drafts/${draft.id}/sent`)).json();
    assert.equal(sent.status, 'sent');
    assert.equal(hook.posts.length, postsBefore, 'drafting sends nothing to Teams or anyone');
  });

  test('state-changing calls reject non-JSON (cross-site) requests', async () => {
    const r = await fetch(`${base}/briefings/morning/run`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
  });

  test('status reports Claude usage, briefings and notifications', async () => {
    await post('/briefings/morning/run');
    const s = await (await fetch(`${base}/status`)).json();
    assert.equal(s.claude.today.calls, 1);
    assert.equal(s.claude.today.inputTokens, 900);
    assert.equal(s.briefingsToday[0].kind, 'morning');
    assert.ok(s.briefingsToday[0].sentAt);
    assert.equal(s.notifications.teamsConfigured, true);
  });
});

describe('resilience', () => {
  test('daily Claude limit falls back to rule-based briefings', async () => {
    server?.close();
    await setup({ dailyCallLimit: 0 });
    const r = await (await post('/briefings/morning/run')).json();
    assert.equal(r.method, 'rules-fallback');
    assert.equal(claudeFake.calls.length, 0);
    assert.match(r.content, /1\. Today's priorities/);
    assert.match(r.content, /8\. Recommended focus/);
    assert.equal(r.sent, true);
  });

  test('Teams outage: retried, recorded, and re-sent later without a second Claude call', async () => {
    server?.close();
    await setup({ failTimes: 3 });
    const first = await (await post('/briefings/morning/run')).json();
    assert.equal(first.sent, false);
    assert.match(first.error, /HTTP 503/);
    assert.equal(hook.posts.length, 3, 'three attempts');
    assert.equal((await (await fetch(`${base}/status`)).json()).status, 'degraded');

    const retry = await (await post('/briefings/morning/run')).json();
    assert.equal(retry.sent, true);
    assert.equal(claudeFake.calls.length, 1, 'content reused, not regenerated');
    assert.ok(!JSON.stringify(store.getBriefing('morning', dayKey(new Date(), 'America/New_York'))).includes('sig=secret'), 'webhook secret never stored');
  });

  test('without a webhook, notifications are a logged dry run', async () => {
    const n = createTeamsNotifier({ webhookUrl: '' });
    assert.deepEqual(await n.send({ title: 'x', body: 'y' }), { dryRun: true });
  });

});

test('teardown', () => server?.close());
