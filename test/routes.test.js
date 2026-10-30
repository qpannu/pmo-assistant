import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

test('action routes list items with sources and update status locally', async () => {
  const db = openDb(':memory:');
  const store = createStore(db);
  const item = store.upsertItem({ source: 'outlook', externalId: 'e1', kind: 'email', title: 'Budget', url: 'https://outlook/e1', data: {} });
  const { id } = store.upsertActionItem({ dedupeKey: 'outlook:c1:decide', type: 'decide', title: 'Approve budget' });
  store.linkActionSource(id, item.id);

  const scheduler = createScheduler();
  const server = createApp(loadConfig(), { db, store, scheduler }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/actions`)).json();
    assert.equal(list.count, 1);
    assert.equal(list.actions[0].sources[0].url, 'https://outlook/e1');

    const form = await fetch(`${base}/actions/${id}/status`, { method: 'POST', body: 'status=done', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415, 'non-JSON (cross-site form) rejected');

    const bad = await fetch(`${base}/actions/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'sent' }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/actions/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'done' }), headers: { 'Content-Type': 'application/json' } });
    const updated = await ok.json();
    assert.equal(updated.status, 'done');
    assert.equal(updated.closed_reason, 'user');

    const sync = await fetch(`${base}/outlook/sync`, { method: 'POST' });
    assert.equal(sync.status, 503);
    assert.match((await sync.json()).error, /ms:login/);
  } finally {
    server.close();
    scheduler.stop();
  }
});

test('the dashboard page and script are served with a strict content policy', async () => {
  const db = openDb(':memory:');
  const store = createStore(db);
  const scheduler = createScheduler();
  const server = createApp(loadConfig(), { db, store, scheduler }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
    const html = await page.text();
    assert.match(html, /<script src="\/dashboard\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>(?!<\/)/, 'no inline script');
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/, 'no third-party resources');
    const js = await fetch(`${base}/dashboard.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.doesNotMatch(await js.text(), /innerHTML/, 'Jira text is never inserted as HTML');
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.headers.get('location'), '/dashboard');
  } finally {
    server.close();
    scheduler.stop();
  }
});
