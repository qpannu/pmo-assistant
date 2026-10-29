import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createStore, contentHash } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('warn');

let db, store;
beforeEach(() => {
  db = openDb(':memory:');
  store = createStore(db);
});

test('migrations run once and are idempotent on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmo-db-'));
  try {
    const path = join(dir, 'nested', 'pmo.db');
    openDb(path).close();
    const again = openDb(path);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 1);
    const tables = again.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name);
    assert.deepEqual(tables, ['action_items', 'alerts', 'drafts', 'history', 'items', 'processed_events', 'sync_state']);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimEvent accepts an event once and rejects duplicates', () => {
  assert.equal(store.claimEvent('jira', 'evt-1'), true);
  assert.equal(store.claimEvent('jira', 'evt-1'), false);
  assert.equal(store.claimEvent('outlook', 'evt-1'), true, 'ids are scoped per source');
  assert.equal(store.pruneProcessedEvents(30), 0, 'recent events are kept');
  assert.equal(store.pruneProcessedEvents(-1), 2, 'a cutoff in the future removes all');
});

test('contentHash ignores key order', () => {
  assert.equal(contentHash({ a: 1, b: { c: 2, d: 3 } }), contentHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test('unchanged items are not re-queued for analysis', () => {
  const base = { source: 'jira', externalId: 'PRJ-1', kind: 'issue', title: 'Login fails', data: { status: 'Open', priority: 'High' } };

  const first = store.upsertItem(base);
  assert.deepEqual({ isNew: first.isNew, changed: first.changed }, { isNew: true, changed: true });
  assert.equal(store.itemsNeedingAnalysis().length, 1);

  const [pending] = store.itemsNeedingAnalysis();
  store.markAnalyzed(pending.id, pending.content_hash);
  assert.equal(store.itemsNeedingAnalysis().length, 0);

  const same = store.upsertItem({ ...base, data: { priority: 'High', status: 'Open' } });
  assert.equal(same.changed, false);
  assert.equal(store.itemsNeedingAnalysis().length, 0);

  const updated = store.upsertItem({ ...base, data: { status: 'Blocked', priority: 'High' } });
  assert.deepEqual({ id: updated.id, changed: updated.changed }, { id: first.id, changed: true });
  assert.equal(store.itemsNeedingAnalysis().length, 1);
  assert.equal(store.getItem(first.id).data.status, 'Blocked');
});

test('an item that changes during analysis stays pending', () => {
  const base = { source: 'teams', externalId: 'm1', kind: 'chat_message', data: { text: 'v1' } };
  store.upsertItem(base);
  const [seen] = store.itemsNeedingAnalysis();
  store.upsertItem({ ...base, data: { text: 'v2' } }); // edited while Claude was working
  store.markAnalyzed(seen.id, seen.content_hash);
  assert.equal(store.itemsNeedingAnalysis().length, 1);
});

test('action items dedupe and are never reopened by re-analysis', () => {
  const a = store.upsertActionItem({ dedupeKey: 'jira:PRJ-1:respond', type: 'respond', title: 'Reply to QA', priority: 2 });
  const b = store.upsertActionItem({ dedupeKey: 'jira:PRJ-1:respond', type: 'respond', title: 'Reply to QA (updated)', priority: 1 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.id, b.id);
  assert.equal(store.listOpenActions()[0].title, 'Reply to QA (updated)');

  store.setActionStatus(a.id, 'dismissed');
  store.upsertActionItem({ dedupeKey: 'jira:PRJ-1:respond', type: 'respond', title: 'again', priority: 1 });
  assert.equal(store.listOpenActions().length, 0);
  assert.deepEqual(store.listHistory('action_item', a.id).map((h) => h.event), ['created', 'status:dismissed']);
});

test('open actions sort by priority then due date, and expired snoozes resurface', () => {
  store.upsertActionItem({ dedupeKey: 'k3', type: 'review', title: 'P3', priority: 3 });
  store.upsertActionItem({ dedupeKey: 'k1b', type: 'decide', title: 'P1 later', priority: 1, dueAt: '2026-11-05T00:00:00Z' });
  store.upsertActionItem({ dedupeKey: 'k1a', type: 'decide', title: 'P1 sooner', priority: 1, dueAt: '2026-11-01T00:00:00Z' });
  const snoozed = store.upsertActionItem({ dedupeKey: 'k2', type: 'follow_up', title: 'P2 snoozed', priority: 2 });
  const resurfaced = store.upsertActionItem({ dedupeKey: 'k2b', type: 'follow_up', title: 'P2 resurfaced', priority: 2 });

  assert.throws(() => store.setActionStatus(snoozed.id, 'snoozed'), /snoozedUntil is required/);
  store.setActionStatus(snoozed.id, 'snoozed', { snoozedUntil: '2999-01-01T00:00:00Z' });
  store.setActionStatus(resurfaced.id, 'snoozed', { snoozedUntil: '2000-01-01T00:00:00Z' });

  assert.deepEqual(store.listOpenActions().map((a) => a.title), ['P1 sooner', 'P1 later', 'P2 resurfaced', 'P3']);
});

test('alerts are raised once per dedupe key', () => {
  const first = store.raiseAlert({ dedupeKey: 'release:4.2:blocker', severity: 'critical', title: 'Release 4.2 blocked' });
  const repeat = store.raiseAlert({ dedupeKey: 'release:4.2:blocker', severity: 'critical', title: 'Release 4.2 blocked' });
  assert.equal(first.created, true);
  assert.equal(repeat.created, false);
  assert.equal(repeat.id, first.id);
  assert.equal(store.listActiveAlerts().length, 1);
  assert.equal(store.acknowledgeAlert(first.id), true);
  assert.equal(store.acknowledgeAlert(first.id), false);
  assert.equal(store.listActiveAlerts().length, 0);
});

test('drafts cannot be sent without approval, and are sent at most once', () => {
  const id = store.createDraft({ channel: 'email', target: { to: ['dev@example.com'] }, subject: 'Status', body: 'Hi' });

  assert.equal(store.claimDraftForSend(id), null, 'pending draft must not be sendable');
  assert.equal(store.editDraft(id, { body: 'Hi team' }), true);

  assert.equal(store.approveDraft(id), true);
  assert.equal(store.editDraft(id, { body: 'sneaky change' }), false, 'approved text is frozen');
  assert.equal(store.rejectDraft(id), false);

  const claimed = store.claimDraftForSend(id);
  assert.equal(claimed.body, 'Hi team');
  assert.deepEqual(claimed.target, { to: ['dev@example.com'] });
  assert.equal(store.claimDraftForSend(id), null, 'second claim must fail');

  assert.equal(store.markDraftSent(id), true);
  assert.equal(store.getDraft(id).status, 'sent');
  assert.deepEqual(store.listHistory('draft', id).map((h) => h.event),
    ['created', 'edited', 'status:approved', 'status:sending', 'status:sent']);
});

test('rejected and failed drafts are recorded', () => {
  const rejected = store.createDraft({ channel: 'teams', target: { chatId: 'c1' }, body: 'x' });
  assert.equal(store.rejectDraft(rejected), true);
  assert.equal(store.approveDraft(rejected), false);

  const failed = store.createDraft({ channel: 'jira_comment', target: { issueKey: 'PRJ-1' }, body: 'y' });
  store.approveDraft(failed);
  store.claimDraftForSend(failed);
  assert.equal(store.markDraftFailed(failed, 'HTTP 403'), true);
  assert.equal(store.getDraft(failed).error, 'HTTP 403');
  assert.deepEqual(store.listDrafts('pending'), []);
});

test('sync state keeps the cursor across errors', () => {
  assert.equal(store.getSyncState('outlook'), null);
  store.saveSyncSuccess('outlook', 'delta-link-1');
  store.saveSyncError('outlook', 'timeout');
  const s = store.getSyncState('outlook');
  assert.equal(s.cursor, 'delta-link-1');
  assert.equal(s.last_error, 'timeout');
  store.saveSyncSuccess('outlook', 'delta-link-2');
  assert.equal(store.getSyncState('outlook').last_error, null);
});
