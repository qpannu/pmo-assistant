import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../src/outlook/normalize.js';
import { classifyEmail, myIdentity } from '../src/outlook/classify.js';
import { syncOutlook, outlookOverview } from '../src/outlook/sync.js';
import { syncActions } from '../src/actions.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const ME = { id: 'u-me', displayName: 'Qaiser Pannu', mail: 'qp@corp.com', userPrincipalName: 'qp@corp.com' };
const me = myIdentity(ME);
const ms = { mailLookbackDays: 14, replyWindowDays: 7, followUpAfterDays: 3, maxMessagesPerSync: 500 };
const NOW = new Date('2026-10-29T15:00:00Z');

let seq = 0;
function graphMsg({ id = `m${++seq}`, conv = 'c1', from = 'alice@corp.com', fromName = 'Alice', to = ['qp@corp.com'], cc = [],
  subject = 'Hello', preview = '', received = '2026-10-29T10:00:00Z', importance = 'normal', flag, other = false } = {}) {
  return {
    id, conversationId: conv, subject, bodyPreview: preview, importance,
    from: { emailAddress: { name: fromName, address: from } },
    toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
    ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
    receivedDateTime: received, sentDateTime: received,
    flag: flag ? { flagStatus: 'flagged', dueDateTime: { dateTime: flag } } : { flagStatus: 'notFlagged' },
    inferenceClassification: other ? 'other' : 'focused',
    webLink: `https://outlook.office365.com/owa/?ItemID=${id}`,
  };
}
const inbound = (o) => normalizeMessage(graphMsg(o), 'inbox');
const sent = (o) => normalizeMessage(graphMsg({ from: 'qp@corp.com', fromName: 'Qaiser Pannu', to: ['alice@corp.com'], ...o }), 'sentitems');
const classify = (msg, thread = [msg]) => classifyEmail(msg, thread, me, ms, NOW).signals;

describe('classify email', () => {
  test('a direct question from a person needs a response', () => {
    assert.deepEqual(classify(inbound({ subject: 'Timeline', preview: 'Can you confirm the date for REST?' })), ['response_needed']);
  });

  test('unread FYI, newsletters, notifications and broadcasts are not action items', () => {
    assert.deepEqual(classify(inbound({ preview: 'FYI, the deck is attached.' })), []);
    assert.deepEqual(classify(inbound({ preview: 'Can you take the survey?', other: true })), [], 'Focused Inbox "Other"');
    assert.deepEqual(classify(inbound({ from: 'jira@madmobile-eng.atlassian.net', preview: 'Can you review REST-1?' })), []);
    const many = Array.from({ length: 30 }, (_, i) => `p${i}@corp.com`).concat('qp@corp.com');
    assert.deepEqual(classify(inbound({ to: many, preview: 'Can everyone update their status?' })), []);
  });

  test('cc counts when I am named; otherwise not', () => {
    assert.deepEqual(classify(inbound({ to: ['bob@corp.com'], cc: ['qp@corp.com'], preview: 'Bob, can you check?' })), []);
    assert.deepEqual(classify(inbound({ to: ['bob@corp.com'], cc: ['qp@corp.com'], preview: 'Qaiser, can you approve the release?' })),
      ['approval_requested', 'release_related'], 'approval replaces a generic response');
  });

  test('replying in the thread clears it; old requests expire', () => {
    const q = inbound({ conv: 'c9', preview: 'Can you send the plan?', received: '2026-10-28T10:00:00Z' });
    const reply = sent({ conv: 'c9', received: '2026-10-28T12:00:00Z', preview: 'Here it is.' });
    assert.deepEqual(classify(q, [q, reply]), []);
    assert.deepEqual(classify(inbound({ preview: 'Can you send the plan?', received: '2026-10-10T10:00:00Z' })), []);
  });

  test('urgency and deadlines', () => {
    const msg = inbound({ preview: 'Prod is down at Sweet Eatery, please advise by EOD', importance: 'high' });
    const r = classifyEmail(msg, [msg], me, ms, NOW);
    assert.deepEqual(r.signals, ['response_needed', 'urgent']);
    assert.equal(r.dueDate, '2026-10-29');
  });

  test('flagged emails are follow-ups even when automated', () => {
    const r = classifyEmail(inbound({ from: 'noreply@x.com', flag: '2026-11-02T00:00:00' }), [], me, ms, NOW);
    assert.deepEqual(r.signals, ['flagged']);
    assert.equal(r.dueDate, '2026-11-02');
  });

  test('my commitments and unanswered questions in sent mail', () => {
    const promise = sent({ preview: "I'll send the RCA by Friday.", received: '2026-10-28T09:00:00Z' });
    const r = classifyEmail(promise, [promise], me, ms, NOW);
    assert.deepEqual(r.signals, ['my_commitment']);
    assert.equal(r.dueDate, '2026-10-30');

    const ask = sent({ conv: 'c5', preview: 'Can you share the test results?', received: '2026-10-24T09:00:00Z' });
    assert.deepEqual(classify(ask, [ask]), ['awaiting_their_reply']);
    const answer = inbound({ conv: 'c5', preview: 'Attached.', received: '2026-10-25T09:00:00Z' });
    assert.deepEqual(classify(ask, [ask, answer]), []);
    assert.deepEqual(classify(sent({ preview: 'Can you share it?', received: '2026-10-28T09:00:00Z' })), [], 'too soon to chase');
  });
});

describe('outlook sync', () => {
  let store, calls, pages;

  beforeEach(() => {
    store = createStore(openDb(':memory:'));
    calls = [];
    pages = { inbox: [], sentitems: [] };
  });

  // Fake Graph: each collect() returns the next queued page for the folder.
  const graph = () => ({
    me: async () => ME,
    collect: async (url, opts) => {
      calls.push({ url, query: opts.query });
      const folder = url.includes('sentitems') || url.includes('sent-delta') ? 'sentitems' : 'inbox';
      const next = pages[folder].shift();
      if (next instanceof Error) throw next;
      return { items: next ?? [], deltaLink: `https://graph.microsoft.com/v1.0/${folder === 'inbox' ? 'inbox' : 'sent'}-delta?n=${calls.length}` };
    },
  });

  test('first run uses a lookback filter, later runs use the delta link', async () => {
    pages.inbox.push([graphMsg({ id: 'a', preview: 'Can you review this?' })]);
    const first = await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.equal(first.newItems, 1);
    assert.match(calls[0].url, /\/me\/mailFolders\/inbox\/messages\/delta$/);
    assert.match(calls[0].query.$filter, /^receivedDateTime ge 2026-10-15/);

    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.match(calls[2].url, /inbox-delta\?n=/);
    assert.equal(calls[2].query, undefined);
  });

  test('unchanged messages are not re-processed; read state is ignored', async () => {
    const m = graphMsg({ id: 'a', preview: 'Can you review this?' });
    pages.inbox.push([m]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    syncActions(store);
    assert.equal(store.itemsNeedingActions().length, 0);

    pages.inbox.push([{ ...m, isRead: true }]);
    const r = await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.deepEqual({ n: r.newItems, c: r.changedItems, u: r.unchanged }, { n: 0, c: 0, u: 1 });
    assert.equal(store.itemsNeedingActions().length, 0);
  });

  test('my reply resolves the action; a new question reopens it', async () => {
    pages.inbox.push([graphMsg({ id: 'q1', conv: 'cx', subject: 'Budget', preview: 'Can you approve the budget?', received: '2026-10-29T09:00:00Z' })]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    syncActions(store);
    let [action] = store.listOpenActions();
    assert.equal(action.type, 'decide');
    assert.match(action.title, /Approval requested by Alice: Budget/);
    assert.equal(store.listActionSources(action.id)[0].url, 'https://outlook.office365.com/owa/?ItemID=q1', 'link to original kept');

    pages.sentitems.push([graphMsg({ id: 'r1', conv: 'cx', from: 'qp@corp.com', to: ['alice@corp.com'], preview: 'Approved.', received: '2026-10-29T11:00:00Z' })]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    const stats = syncActions(store);
    assert.equal(stats.resolved, 1);
    assert.equal(store.listOpenActions().length, 0);
    assert.equal(store.getActionItem(action.id).closed_reason, 'auto');

    pages.inbox.push([graphMsg({ id: 'q2', conv: 'cx', subject: 'RE: Budget', preview: 'Thanks! Can you also approve the Q1 line?', received: '2026-10-29T13:00:00Z' })]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.equal(syncActions(store).reopened, 1);
    [action] = store.listOpenActions();
    assert.equal(store.listActionSources(action.id).length, 1);
  });

  test('deleted messages drop their actions', async () => {
    pages.inbox.push([graphMsg({ id: 'd1', preview: 'Can you call me?' })]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    syncActions(store);
    assert.equal(store.listOpenActions().length, 1);

    pages.inbox.push([{ id: 'd1', '@removed': { reason: 'deleted' } }]);
    const r = await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.equal(r.removed, 1);
    syncActions(store);
    assert.equal(store.listOpenActions().length, 0);
  });

  test('an expired delta link restarts from the lookback window', async () => {
    pages.inbox.push([]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    pages.inbox.push(Object.assign(new Error('gone'), { status: 410 }));
    pages.inbox.push([graphMsg({ id: 'z' })]);
    const r = await syncOutlook({ graph: graph(), store, ms, now: NOW });
    assert.equal(r.newItems, 1);
    assert.ok(calls.at(-2).query?.$filter, 'restarted with filter');
  });

  test('overview groups what needs me', async () => {
    pages.inbox.push([graphMsg({ id: 'o1', preview: 'Can you review the release notes?' })]);
    await syncOutlook({ graph: graph(), store, ms, now: NOW });
    const o = outlookOverview(store);
    assert.equal(o.responseNeeded.length, 1);
    assert.equal(o.responseNeeded[0].from, 'Alice');
  });
});
