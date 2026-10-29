import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../src/jira/client.js';
import { adfToText, normalizeIssue } from '../src/jira/normalize.js';
import { compileRules, issueSignals, releaseRisk, SIGNALS } from '../src/jira/classify.js';
import { buildRelevanceJql, syncJira, jiraOverview } from '../src/jira/sync.js';
import { createScheduler } from '../src/scheduler.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const ME = 'acc-me';
const OTHER = 'acc-other';

const jiraCfg = (over = {}) => ({
  projects: ['OS'],
  prodIssueTypes: ['Bug'],
  blockerPriorities: ['Highest', 'High'],
  prodLabels: [],
  decisionLabels: ['needs-decision'],
  decisionStatuses: ['Pending Decision'],
  blockedStatuses: ['Blocked', 'On Hold'],
  releaseWindowDays: 14,
  releaseOverdueDays: 14,
  fullSyncHours: 24,
  maxIssuesPerSync: 500,
  watcherActiveDays: 90,
  prodActiveDays: 30,
  replyWindowDays: 14,
  ...over,
});

const adf = (...content) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

// Raw Jira issue as returned by /rest/api/3/search/jql.
function rawIssue(id, key, f = {}) {
  return {
    id: String(id),
    key,
    fields: {
      summary: f.summary ?? `Summary ${key}`,
      status: { name: f.status ?? 'Open', statusCategory: { key: f.statusCategory ?? 'new' } },
      priority: { name: f.priority ?? 'Medium' },
      issuetype: { name: f.type ?? 'Story' },
      project: { key: key.split('-')[0] },
      assignee: f.assignee ? { accountId: f.assignee, displayName: f.assignee } : null,
      reporter: { accountId: f.reporter ?? OTHER, displayName: 'Rep' },
      duedate: f.dueDate ?? null,
      labels: f.labels ?? [],
      fixVersions: f.fixVersions ?? [],
      issuelinks: f.issuelinks ?? [],
      comment: { comments: f.comments ?? [], total: (f.comments ?? []).length },
      created: '2026-10-01T10:00:00.000+0000',
      updated: f.updated ?? '2026-10-28T10:00:00.000+0000',
    },
  };
}

function fakeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('jira client', () => {
  test('sends only authenticated GET requests and paginates', async () => {
    const calls = [];
    const pages = [
      { issues: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2', isLast: false },
      { issues: [{ id: '3' }], isLast: true },
    ];
    const client = createJiraClient(
      { baseUrl: 'https://x.atlassian.net/', email: 'me@x.com', apiToken: 'tok' },
      { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return fakeResponse(200, pages[calls.length - 1]); } },
    );
    const { issues, truncated } = await client.search({ jql: 'assignee = currentUser()', fields: ['summary'] });

    assert.deepEqual(issues.map((i) => i.id), ['1', '2', '3']);
    assert.equal(truncated, false);
    assert.ok(calls.every((c) => c.opts.method === 'GET'), 'read-only: GET only');
    assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('me@x.com:tok').toString('base64'));
    assert.match(calls[0].url, /^https:\/\/x\.atlassian\.net\/rest\/api\/3\/search\/jql\?/);
    assert.equal(new URL(calls[1].url).searchParams.get('nextPageToken'), 'p2');
  });

  test('stops at the issue limit and reports truncation', async () => {
    const client = createJiraClient({ baseUrl: 'https://x', email: 'e', apiToken: 't' }, {
      fetchImpl: async () => fakeResponse(200, { issues: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'n', isLast: false }),
    });
    const r = await client.search({ jql: 'x', fields: ['summary'], limit: 2 });
    assert.equal(r.issues.length, 2);
    assert.equal(r.truncated, true);
  });

  test('retries on 429 and then succeeds', async () => {
    let n = 0;
    const client = createJiraClient({ baseUrl: 'https://x', email: 'e', apiToken: 't' }, {
      retryDelayMs: 1,
      fetchImpl: async () => (++n === 1 ? fakeResponse(429, {}, { 'retry-after': '0' }) : fakeResponse(200, { accountId: ME })),
    });
    assert.equal((await client.myself()).accountId, ME);
    assert.equal(n, 2);
  });

  test('explains auth failures without leaking the token', async () => {
    const client = createJiraClient({ baseUrl: 'https://x', email: 'e', apiToken: 'super-secret' }, {
      fetchImpl: async () => fakeResponse(401, { errorMessages: ['Unauthorized'] }),
    });
    await assert.rejects(client.myself(), (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /JIRA_API_TOKEN/);
      assert.ok(!err.message.includes('super-secret'));
      return true;
    });
  });
});

describe('normalize', () => {
  test('ADF text and mentions are extracted', () => {
    const { text, mentions } = adfToText(adf(
      { type: 'mention', attrs: { id: ME, text: '@Me' } },
      { type: 'text', text: ' can you decide?' },
    ));
    assert.equal(text, '@Me can you decide?');
    assert.deepEqual(mentions, [ME]);
  });

  test('keeps only needed fields, last 3 comments and open blockers', () => {
    const comments = [1, 2, 3, 4].map((n) => ({ id: String(n), author: { accountId: OTHER, displayName: 'O' }, created: 'x', body: adf({ type: 'text', text: `c${n}` }) }));
    const issue = normalizeIssue(rawIssue(1, 'OS-1', {
      labels: ['b', 'a'],
      comments,
      issuelinks: [
        { type: { inward: 'is blocked by' }, inwardIssue: { key: 'OS-9', fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } } },
        { type: { inward: 'relates to' }, inwardIssue: { key: 'OS-8', fields: { status: { name: 'Open' } } } },
      ],
    }));
    assert.deepEqual(issue.recentComments.map((c) => c.text), ['c2', 'c3', 'c4']);
    assert.deepEqual(issue.labels, ['a', 'b']);
    assert.deepEqual(issue.blockedBy, [{ key: 'OS-9', status: 'Open', done: false }]);
    assert.equal('updated' in issue, false, 'volatile timestamp kept out of hashed data');
  });
});

describe('classify', () => {
  const rules = compileRules(jiraCfg());
  const today = '2026-10-29';
  const now = new Date('2026-10-29T12:00:00');
  const signals = (f, updatedAt = '2026-10-28T10:00:00.000+0000') =>
    issueSignals(normalizeIssue(rawIssue(1, 'OS-1', f)), ME, rules, { now, updatedAt });

  test('assigned, overdue and due soon', () => {
    assert.deepEqual(signals({ assignee: ME, dueDate: '2026-10-20' }), [SIGNALS.ASSIGNED_TO_ME, SIGNALS.OVERDUE].sort());
    assert.deepEqual(signals({ assignee: ME, dueDate: '2026-10-31' }), [SIGNALS.ASSIGNED_TO_ME, SIGNALS.DUE_SOON].sort());
    assert.deepEqual(signals({ assignee: OTHER, dueDate: '2026-10-20' }), [], 'others\' deadlines are not mine');
  });

  test('awaiting decision by label or status, case-insensitive', () => {
    assert.ok(signals({ labels: ['Needs-Decision'] }).includes(SIGNALS.AWAITING_DECISION));
    assert.ok(signals({ status: 'pending decision' }).includes(SIGNALS.AWAITING_DECISION));
  });

  test('awaiting reply only for a recent latest comment that mentions me, asks something, and is not mine', () => {
    const mention = (author, created = '2026-10-27T09:00:00.000+0000', text = ' can you confirm the scope?') =>
      ({ id: '1', author: { accountId: author, displayName: 'x' }, created,
        body: adf({ type: 'mention', attrs: { id: ME } }, { type: 'text', text }) });
    assert.ok(signals({ comments: [mention(OTHER)] }).includes(SIGNALS.AWAITING_REPLY));
    assert.ok(!signals({ comments: [mention(ME)] }).includes(SIGNALS.AWAITING_REPLY));
    assert.ok(!signals({ comments: [mention(OTHER, '2026-09-01T09:00:00.000+0000')] }).includes(SIGNALS.AWAITING_REPLY), 'stale mention');
    assert.ok(!signals({ comments: [mention(OTHER, undefined, ' Thank you for the update.')] }).includes(SIGNALS.AWAITING_REPLY), 'thanks is not a question');
  });

  test('production blockers and blocked issues; done issues have no signals', () => {
    assert.ok(signals({ type: 'Bug', priority: 'High' }).includes(SIGNALS.PRODUCTION_BLOCKER));
    assert.ok(!signals({ type: 'Bug', priority: 'Low' }).includes(SIGNALS.PRODUCTION_BLOCKER));
    assert.ok(!signals({ type: 'Bug', priority: 'High' }, '2024-03-01T10:00:00.000+0000').includes(SIGNALS.PRODUCTION_BLOCKER),
      'inactive backlog bug is not a blocker');
    assert.ok(signals({ status: 'On Hold' }).includes(SIGNALS.BLOCKED));
    assert.deepEqual(signals({ type: 'Bug', priority: 'Highest', assignee: ME, statusCategory: 'done' }), []);
  });

  test('prod labels narrow production bugs when configured', () => {
    const labelled = compileRules(jiraCfg({ prodLabels: ['production'] }));
    const s = (labels) => issueSignals(normalizeIssue(rawIssue(1, 'OS-1', { type: 'Bug', priority: 'High', labels })), ME, labelled,
      { now, updatedAt: '2026-10-28T10:00:00.000+0000' });
    assert.ok(!s([]).includes(SIGNALS.PRODUCTION_BLOCKER));
    assert.ok(s(['production']).includes(SIGNALS.PRODUCTION_BLOCKER));
  });

  test('release risk levels', () => {
    const v = (releaseDate) => ({ id: '100', releaseDate, released: false });
    const open = normalizeIssue(rawIssue(1, 'OS-1'));
    const blocked = normalizeIssue(rawIssue(2, 'OS-2', { status: 'Blocked' }));
    const done = normalizeIssue(rawIssue(3, 'OS-3', { statusCategory: 'done' }));

    assert.equal(releaseRisk(v('2026-11-10'), [open, done], rules, today).risk, 'none');
    assert.equal(releaseRisk(v('2026-11-10'), [blocked], rules, today).risk, 'warning');
    assert.equal(releaseRisk(v('2026-10-31'), [open], rules, today).risk, 'warning');
    const crit = releaseRisk(v('2026-10-31'), [blocked], rules, today);
    assert.equal(crit.risk, 'critical');
    assert.deepEqual(crit.blockedIssues, ['OS-2']);
    assert.equal(releaseRisk(v('2026-10-25'), [open], rules, today).risk, 'critical', 'overdue with open work');
  });
});

describe('sync', () => {
  let store, jql, client, versions, results;

  beforeEach(() => {
    store = createStore(openDb(':memory:'));
    jql = [];
    versions = [];
    results = [];
    client = {
      myself: async () => ({ accountId: ME }),
      projectVersions: async () => versions,
      search: async ({ jql: q }) => {
        jql.push(q);
        return { issues: structuredClone(results.shift() ?? []), truncated: false };
      },
      browseUrl: (k) => `https://x/browse/${k}`,
      versionUrl: (p, id) => `https://x/projects/${p}/versions/${id}`,
    };
  });

  const at = (iso) => new Date(iso);

  test('relevance JQL covers me, decisions, prod bugs and releases, with quoting', () => {
    const q = buildRelevanceJql(jiraCfg({ projects: ['OS', 'REST'] }), ['100']);
    assert.match(q, /assignee = currentUser\(\) OR reporter = currentUser\(\) OR \(watcher = currentUser\(\) AND updated >= -90d\)/);
    assert.match(buildRelevanceJql(jiraCfg({ watcherActiveDays: 0 })), /OR watcher = currentUser\(\) OR/);
    assert.match(q, /labels in \("needs-decision"\)/);
    assert.match(q, /project in \("OS", "REST"\) AND issuetype in \("Bug"\) AND priority in \("Highest", "High"\)/);
    assert.match(q, /fixVersion in \(100\)/);
    assert.doesNotMatch(buildRelevanceJql(jiraCfg({ projects: [] })), /issuetype/, 'no unscoped company-wide bug query');
  });

  test('first run is full, next is incremental, and unchanged issues are not re-processed', async () => {
    const issue = rawIssue(1, 'OS-1', { assignee: ME });
    results.push([issue]);
    const first = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:00:00Z') });
    assert.equal(first.mode, 'full');
    assert.equal(first.newItems, 1);
    assert.match(jql[0], /statusCategory != Done/);

    const [pending] = store.itemsNeedingAnalysis();
    store.markAnalyzed(pending.id, pending.content_hash);

    // Same issue again, only Jira's `updated` timestamp moved.
    results.push([{ ...issue, fields: { ...issue.fields, updated: '2026-10-29T10:05:00.000+0000' } }]);
    const second = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:10:00Z') });
    assert.equal(second.mode, 'incremental');
    assert.match(jql[1], /updated >= -12m/, '10 minutes since last sync + 2 overlap');
    assert.deepEqual({ n: second.newItems, c: second.changedItems, u: second.unchanged }, { n: 0, c: 0, u: 1 });
    assert.equal(store.itemsNeedingAnalysis().length, 0);

    results.push([rawIssue(1, 'OS-1', { assignee: ME, status: 'Blocked' })]);
    const third = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:20:00Z') });
    assert.equal(third.changedItems, 1);
    assert.equal(store.itemsNeedingAnalysis().length, 1);
  });

  test('date-based signals update locally without refetching', async () => {
    const jira = jiraCfg({ fullSyncHours: 24 * 30 }); // keep the second run incremental
    results.push([rawIssue(1, 'OS-1', { assignee: ME, dueDate: '2026-11-05' })]);
    await syncJira({ client, store, jira, now: at('2026-10-29T10:00:00Z') });
    assert.equal(jiraOverview(store).dueSoon.length, 0);

    await syncJira({ client, store, jira, now: at('2026-11-03T10:00:00Z') });
    assert.match(jql[1], /updated >=/);
    assert.equal(jiraOverview(store).dueSoon[0].key, 'OS-1');
  });

  test('full sync drops issues no longer in scope', async () => {
    results.push([rawIssue(1, 'OS-1', { assignee: ME }), rawIssue(2, 'OS-2', { labels: ['needs-decision'] })]);
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:00:00Z') });
    assert.equal(jiraOverview(store).trackedIssues, 2);

    results.push([rawIssue(1, 'OS-1', { assignee: ME })]); // OS-2 label removed / closed
    const r = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-30T11:00:00Z') });
    assert.equal(r.mode, 'full');
    const o = jiraOverview(store);
    assert.equal(o.trackedIssues, 1);
    assert.equal(o.awaitingMyDecision.length, 0);
  });

  test('upcoming releases get risk, and newly upcoming releases load their issues once', async () => {
    results.push([]);
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:00:00Z') });

    versions = [
      { id: '100', name: '4.2', releaseDate: '2026-10-31', released: false },
      { id: '200', name: '5.0', releaseDate: '2027-03-01', released: false },
      { id: '300', name: '4.1', releaseDate: '2026-10-01', released: true },
      { id: '400', name: '3.0', releaseDate: '2026-06-01', released: false }, // long overdue = abandoned
    ];
    const fix = [{ id: '100', name: '4.2', releaseDate: '2026-10-31' }];
    results.push([]); // incremental: nothing changed
    results.push([rawIssue(5, 'OS-5', { status: 'Blocked', fixVersions: fix })]); // release backfill
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:10:00Z') });

    assert.match(jql[2], /^fixVersion in \(100\) AND statusCategory != Done$/);
    const { releases, releasesAtRisk: [release] } = jiraOverview(store);
    assert.deepEqual(releases.map((r) => r.name), ['OS 4.2'], 'only versions in the window are tracked');
    assert.equal(release.name, 'OS 4.2');
    assert.equal(release.risk, 'critical');

    results.push([]);
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:20:00Z') });
    assert.equal(jql.length, 4, 'no second backfill for an already-known release');
  });

  test('a truncated full sync is retried as full and drops nothing', async () => {
    results.push([rawIssue(1, 'OS-1', { assignee: ME }), rawIssue(2, 'OS-2', { assignee: ME })]);
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:00:00Z') });

    const search = client.search;
    client.search = async (args) => ({ ...(await search(args)), truncated: true });
    results.push([rawIssue(1, 'OS-1', { assignee: ME })]);
    const r = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-30T11:00:00Z') });
    assert.equal(r.truncated, true);
    assert.equal(jiraOverview(store).trackedIssues, 2, 'OS-2 kept: the result was incomplete');

    results.push([]);
    const next = await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-30T11:10:00Z') });
    assert.equal(next.mode, 'full');
  });

  test('failures are recorded and the cursor is kept', async () => {
    results.push([]);
    await syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:00:00Z') });
    const before = store.getSyncState('jira').cursor;

    client.search = async () => { throw new Error('Jira HTTP 400: bad JQL'); };
    await assert.rejects(syncJira({ client, store, jira: jiraCfg(), now: at('2026-10-29T10:10:00Z') }), /bad JQL/);
    const state = store.getSyncState('jira');
    assert.equal(state.cursor, before);
    assert.match(state.last_error, /bad JQL/);
  });
});

test('scheduler never runs a task twice at the same time', async () => {
  const scheduler = createScheduler();
  let runs = 0;
  let release;
  scheduler.every('t', 60, () => { runs++; return new Promise((r) => { release = r; }); }, { initialDelayMs: 60_000 });
  const a = scheduler.runNow('t');
  const b = scheduler.runNow('t');
  release('done');
  assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
  assert.equal(runs, 1);
  scheduler.stop();
});
