import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requireConfig, integrationStatus } from '../src/config.js';
import { redact, setLogLevel } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('config uses defaults and binds to localhost', () => {
  const cfg = withEnv({ PORT: undefined, HOST: undefined }, loadConfig);
  assert.equal(cfg.port, 3100);
  assert.equal(cfg.host, '127.0.0.1');
});

test('config rejects invalid numbers', () => {
  assert.throws(() => withEnv({ PORT: 'abc' }, loadConfig), /PORT must be an integer/);
  assert.throws(() => withEnv({ SYNC_INTERVAL_JIRA: '0' }, loadConfig), /SYNC_INTERVAL_JIRA/);
});

test('requireConfig names missing settings without values', () => {
  const cfg = withEnv({ JIRA_BASE_URL: 'https://x.atlassian.net/', JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined }, loadConfig);
  assert.equal(cfg.jira.baseUrl, 'https://x.atlassian.net');
  assert.throws(
    () => requireConfig(cfg, ['jira.baseUrl', 'jira.email', 'jira.apiToken']),
    /Missing configuration: jira\.email, jira\.apiToken/,
  );
  assert.equal(integrationStatus(cfg).jira, false);
});

test('logger redacts secret-looking keys at any depth', () => {
  const out = redact({ apiToken: 'abc', nested: { Authorization: 'Basic xyz', ok: 1 }, list: [{ password: 'p' }] });
  assert.equal(out.apiToken, '[REDACTED]');
  assert.equal(out.nested.Authorization, '[REDACTED]');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.list[0].password, '[REDACTED]');
});

test('health endpoint reports status without exposing secrets', async () => {
  const cfg = withEnv({ ANTHROPIC_API_KEY: 'sk-test-should-not-leak' }, loadConfig);
  const server = createApp(cfg).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/health`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(text).integrations.claude, true);
    assert.ok(!text.includes('sk-test'));

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('health endpoint reports database status', async () => {
  setLogLevel('warn');
  const db = openDb(':memory:');
  const server = createApp(loadConfig(), { db }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    assert.equal((await (await fetch(url)).json()).db, true);

    db.close();
    const res = await fetch(url);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).status, 'degraded');
  } finally {
    server.close();
    setLogLevel('info');
  }
});
