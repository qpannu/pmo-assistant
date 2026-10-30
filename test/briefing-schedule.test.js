import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';
import { isDue } from '../src/briefing/schedule.js';
import { createBriefingService } from '../src/briefing/briefing.js';
import { createTeamsNotifier } from '../src/notify/teams.js';
import { createClaude } from '../src/claude/client.js';
import { dayKey, zonedParts, zonedTimeToUtc } from '../src/time.js';
import { seedSample } from './fixtures/sample-data.js';

setLogLevel('error');

const TZ = 'America/New_York';
const cfg = { times: { morning: '07:00', midday: '12:30', eod: '' }, days: [1, 2, 3, 4, 5], timeZone: TZ, graceMinutes: 240 };
const at = (iso) => new Date(iso);

describe('7:00 AM America/New_York, weekdays, DST-aware', () => {
  const store = createStore(openDb(':memory:'));

  test('summer time (EDT, UTC-4): 7:00 ET is 11:00 UTC', () => {
    assert.equal(isDue('morning', at('2026-10-29T10:59:00Z'), cfg, store), false, '6:59 ET');
    assert.equal(isDue('morning', at('2026-10-29T11:00:00Z'), cfg, store), true, '7:00 ET');
  });

  test('winter time (EST, UTC-5): 7:00 ET is 12:00 UTC after the November change', () => {
    assert.equal(isDue('morning', at('2026-11-02T11:30:00Z'), cfg, store), false, '6:30 ET on Monday Nov 2');
    assert.equal(isDue('morning', at('2026-11-02T12:00:00Z'), cfg, store), true, '7:00 ET');
    assert.equal(zonedTimeToUtc(at('2026-11-02T15:00:00Z'), TZ, 7, 0).toISOString(), '2026-11-02T12:00:00.000Z');
    assert.equal(zonedTimeToUtc(at('2026-03-09T15:00:00Z'), TZ, 7, 0).toISOString(), '2026-03-09T11:00:00.000Z', 'spring forward');
  });

  test('weekdays only, in Eastern time (not the server clock)', () => {
    assert.equal(isDue('morning', at('2026-10-31T11:05:00Z'), cfg, store), false, 'Saturday');
    assert.equal(isDue('morning', at('2026-11-01T12:05:00Z'), cfg, store), false, 'Sunday');
    // 02:00 UTC Friday is still Thursday evening in New York
    assert.equal(zonedParts(at('2026-10-30T02:00:00Z'), TZ).weekday, 4);
    assert.equal(dayKey(at('2026-10-30T02:00:00Z'), TZ), '2026-10-29');
  });

  test('missed run catches up within the grace window, then stops', () => {
    assert.equal(isDue('morning', at('2026-10-29T14:30:00Z'), cfg, store), true, '10:30 ET, machine woke late');
    assert.equal(isDue('morning', at('2026-10-29T15:01:00Z'), cfg, store), false, '11:01 ET, past 4h grace');
  });

  test('a disabled briefing never fires', () => {
    assert.equal(isDue('eod', at('2026-10-29T21:30:00Z'), cfg, store), false);
  });

  test('a sent briefing is not due again that day', () => {
    store.saveBriefing({ kind: 'morning', day: '2026-10-29', method: 'rules', inputHash: 'h', content: 'c' });
    store.markBriefingSent(store.getBriefing('morning', '2026-10-29').id);
    assert.equal(isDue('morning', at('2026-10-29T11:05:00Z'), cfg, store), false);
    assert.equal(isDue('morning', at('2026-10-30T11:05:00Z'), cfg, store), true, 'next day is due');
  });
});

describe('duplicate prevention and recovery', () => {
  const okWebhook = () => {
    const posts = [];
    return { posts, fetchImpl: async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true, status: 202 }; } };
  };
  const NOW = at('2026-10-29T11:00:00Z');

  test('two instances sharing one database send the morning briefing once', async () => {
    const store = createStore(openDb(':memory:'));
    seedSample(store, NOW);
    const hook = okWebhook();
    const notifier = createTeamsNotifier({ webhookUrl: 'https://x.example/hook', fetchImpl: hook.fetchImpl });
    const claude = createClaude({ store, model: 'm', enabled: false });
    const a = createBriefingService({ store, claude, notifier, timeZone: TZ });
    const b = createBriefingService({ store, claude, notifier, timeZone: TZ });

    const [r1, r2] = await Promise.all([a.run('morning', { now: NOW }), b.run('morning', { now: NOW })]);
    assert.equal(hook.posts.length, 1);
    assert.ok([r1, r2].some((r) => r.sent) && [r1, r2].some((r) => r.skipped));
    assert.equal((await a.run('morning', { now: NOW })).skipped, 'already sent');
    assert.equal(hook.posts.length, 1);
  });

  test('a failed send is released and succeeds on the next run, with the same text', async () => {
    const store = createStore(openDb(':memory:'));
    seedSample(store, NOW);
    let fail = true;
    const posts = [];
    const notifier = createTeamsNotifier({
      webhookUrl: 'https://x.example/hook', retryDelayMs: 1,
      fetchImpl: async (url, opts) => { posts.push(opts.body); return fail ? { ok: false, status: 400 } : { ok: true, status: 202 }; },
    });
    const svc = createBriefingService({ store, claude: createClaude({ store, model: 'm', enabled: false }), notifier, timeZone: TZ });

    const first = await svc.run('morning', { now: NOW });
    assert.equal(first.sent, false);
    assert.match(first.error, /HTTP 400/);
    fail = false;
    const second = await svc.run('morning', { now: NOW });
    assert.equal(second.sent, true);
    const text = (p) => JSON.parse(p).attachments[0].content.body[1].text;
    assert.equal(text(posts[0]), text(posts.at(-1)), 'identical briefing text re-sent, not regenerated');
  });

  test('briefing contains all 8 sections and marks missing sources', async () => {
    const store = createStore(openDb(':memory:'));
    seedSample(store, NOW);
    const hook = okWebhook();
    const svc = createBriefingService({
      store, claude: createClaude({ store, model: 'm', enabled: false }),
      notifier: createTeamsNotifier({ webhookUrl: 'https://x.example/hook', fetchImpl: hook.fetchImpl }), timeZone: TZ,
      live: { jiraEnabled: true, scopes: { ezCater: 'project = X' } },
    });
    const r = await svc.run('morning', { now: NOW });
    for (const h of ["1. Today's priorities", '2. Meetings', '3. Pending on you', '4. Production issues', '5. Releases', '6. ezCater', '7. Overdue', '8. Recommended focus']) {
      assert.ok(r.content.includes(h), h);
    }
    assert.match(r.content, /Not available: Outlook calendar not connected/);
    assert.match(r.content, /6\. ezCater\*\*\n- Not available: Jira not configured/);
    assert.match(r.content, /\]\(https:\/\/example\.atlassian\.net\/browse\/REST-900\)/, 'links restored');
    assert.match(hook.posts[0].attachments[0].content.body[0].text, /Morning briefing — Thu, Oct 29/);
  });

  test('unchanged follow-ups are not repeated the next day', async () => {
    const store = createStore(openDb(':memory:'));
    seedSample(store, NOW);
    const svc = createBriefingService({
      store, claude: createClaude({ store, model: 'm', enabled: false }),
      notifier: createTeamsNotifier({ webhookUrl: 'https://x.example/hook', fetchImpl: okWebhook().fetchImpl }), timeZone: TZ,
    });
    const day1 = await svc.run('morning', { now: NOW });
    assert.match(day1.content, /No reply yet: Dev portal access/);
    const day2 = await svc.run('morning', { now: at('2026-10-29T11:00:00Z'), force: true });
    assert.equal(day2.sent, true);
    assert.doesNotMatch(day2.content, /No reply yet: Dev portal access/, 'unchanged low-priority item omitted');
    assert.match(day2.content, /unchanged follow-up\(s\) omitted/);
  });
});
