import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMsAuth, AuthRequiredError } from '../src/microsoft/auth.js';
import { createGraphClient } from '../src/microsoft/graph.js';
import { msScopes } from '../src/config.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  json: async () => body,
});

function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), 'pmo-ms-'));
  return { path: join(dir, 'token.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('scopes', () => {
  test('only what enabled features need', () => {
    const base = { outlookEnabled: true, teamsEnabled: true, teamsChannels: [] };
    assert.deepEqual(msScopes(base), ['offline_access', 'User.Read', 'Mail.Read', 'Chat.Read']);
    assert.deepEqual(msScopes({ ...base, teamsEnabled: false }), ['offline_access', 'User.Read', 'Mail.Read']);
    assert.ok(msScopes({ ...base, teamsChannels: ['T/C'] }).includes('ChannelMessage.Read.All'));
    assert.ok(!msScopes(base).some((s) => /write|send/i.test(s)), 'no write scopes');
  });
});

describe('auth', () => {
  const cfg = (path) => ({ tenantId: 't', clientId: 'c', tokenCachePath: path, scopes: ['offline_access', 'User.Read', 'Mail.Read'] });

  test('device code login polls until approved and stores tokens owner-only', async () => {
    const { path, cleanup } = tmpCache();
    try {
      const calls = [];
      const replies = [
        res(200, { device_code: 'dc', message: 'Go to https://microsoft.com/devicelogin and enter ABC', interval: 1, expires_in: 60 }),
        res(400, { error: 'authorization_pending' }),
        res(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: 'User.Read Mail.Read' }),
      ];
      const auth = createMsAuth(cfg(path), { fetchImpl: async (url, opts) => { calls.push({ url, body: String(opts.body) }); return replies.shift(); } });
      let prompt;
      await auth.deviceCodeLogin({ onPrompt: (m) => { prompt = m; }, sleep: async () => {} });

      assert.match(prompt, /devicelogin/);
      assert.match(calls[0].url, /\/t\/oauth2\/v2\.0\/devicecode$/);
      assert.ok(!calls.some((c) => c.body.includes('client_secret')), 'public client: no secret');
      assert.equal(await auth.getAccessToken(), 'at1');
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).refreshToken, 'rt1');
    } finally {
      cleanup();
    }
  });

  test('refreshes an expiring token and keeps the newest refresh token', async () => {
    const { path, cleanup } = tmpCache();
    try {
      writeFileSync(path, JSON.stringify({ accessToken: 'old', refreshToken: 'rt1', expiresAt: Date.now() + 1000 }));
      let body;
      const auth = createMsAuth(cfg(path), {
        fetchImpl: async (url, opts) => { body = String(opts.body); return res(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 3600, scope: 'User.Read Mail.Read' }); },
      });
      assert.equal(await auth.getAccessToken(), 'new');
      assert.match(body, /grant_type=refresh_token/);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).refreshToken, 'rt2');
    } finally {
      cleanup();
    }
  });

  test('missing or revoked sign-in asks for ms:login', async () => {
    const { path, cleanup } = tmpCache();
    try {
      await assert.rejects(createMsAuth(cfg(path)).getAccessToken(), AuthRequiredError);
      writeFileSync(path, JSON.stringify({ accessToken: 'x', refreshToken: 'bad', expiresAt: 0 }));
      const auth = createMsAuth(cfg(path), { fetchImpl: async () => res(400, { error: 'invalid_grant' }) });
      await assert.rejects(auth.getAccessToken(), /ms:login/);
    } finally {
      cleanup();
    }
  });
});

describe('graph client', () => {
  const auth = (tokens = ['t1', 't2']) => {
    let i = 0;
    return { getAccessToken: async ({ forceRefresh } = {}) => (forceRefresh ? tokens[++i] : tokens[i]) };
  };

  test('GET only, follows nextLink to deltaLink', async () => {
    const calls = [];
    const pages = [
      res(200, { value: [{ id: 1 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next?x=1' }),
      res(200, { value: [{ id: 2 }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc' }),
    ];
    const g = createGraphClient(auth(), { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return pages.shift(); } });
    const r = await g.collect('/me/mailFolders/inbox/messages/delta', { query: { $filter: 'receivedDateTime ge 2026-10-01T00:00:00Z' } });

    assert.deepEqual(r.items.map((i) => i.id), [1, 2]);
    assert.equal(r.deltaLink, 'https://graph.microsoft.com/v1.0/delta?token=abc');
    assert.ok(calls.every((c) => c.opts.method === 'GET'));
    assert.match(calls[0].url, /(\$|%24)filter=receivedDateTime%20ge%202026-10-01T00%3A00%3A00Z/);
  });

  test('stops at the limit and returns the nextLink to resume', async () => {
    const g = createGraphClient(auth(), {
      fetchImpl: async () => res(200, { value: [{ id: 1 }, { id: 2 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/n' }),
    });
    const r = await g.collect('/x', { limit: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.nextLink, 'https://graph.microsoft.com/v1.0/n');
  });

  test('retries throttling, refreshes once on 401, refuses non-Graph URLs', async () => {
    const seen = [];
    const replies = [res(429, {}, { 'retry-after': '0' }), res(401, {}), res(200, { id: 'me' })];
    const g = createGraphClient(auth(), { retryDelayMs: 1, fetchImpl: async (url, opts) => { seen.push(opts.headers.Authorization); return replies.shift(); } });
    assert.equal((await g.get('/me')).id, 'me');
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t1', 'Bearer t2']);
    await assert.rejects(g.get('https://evil.example.com/x'), /non-Graph/);
  });

  test('explains permission errors', async () => {
    const g = createGraphClient(auth(), { fetchImpl: async () => res(403, { error: { code: 'Forbidden', message: 'Missing scope' } }) });
    await assert.rejects(g.get('/me/chats'), /403 Forbidden.*admin consent/);
  });
});
