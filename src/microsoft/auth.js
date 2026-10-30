// Delegated Microsoft sign-in using the OAuth 2.0 device code flow. This is a
// public client: no client secret exists. You sign in once in a browser
// (`npm run ms:login`); afterwards the refresh token keeps access working.
// Tokens live in a local file readable only by your user account.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.js';

const log = logger.child({ component: 'ms-auth' });
const EXPIRY_SKEW_MS = 120_000;

export class AuthRequiredError extends Error {
  constructor(message = 'Microsoft sign-in required: run `npm run ms:login`') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export function createMsAuth({ tenantId, clientId, tokenCachePath, scopes }, { fetchImpl = fetch } = {}) {
  if (!tenantId || !clientId) throw new Error('MS_TENANT_ID and MS_CLIENT_ID are required');
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
  const scope = scopes.join(' ');
  let cached = load();
  let refreshing = null;

  function load() {
    if (!existsSync(tokenCachePath)) return null;
    try {
      return JSON.parse(readFileSync(tokenCachePath, 'utf8'));
    } catch (err) {
      log.warn('token file unreadable; sign in again', { error: err.message });
      return null;
    }
  }

  // Atomic write, owner read/write only.
  function save(tokens) {
    mkdirSync(dirname(tokenCachePath), { recursive: true });
    const tmp = `${tokenCachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
    renameSync(tmp, tokenCachePath);
    chmodSync(tokenCachePath, 0o600);
    cached = tokens;
  }

  async function post(path, params) {
    const res = await fetchImpl(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  function store(body, now = Date.now()) {
    const granted = (body.scope ?? '').toLowerCase().split(' ');
    const missing = scopes.filter((s) => s !== 'offline_access' && !granted.some((g) => g.endsWith(s.toLowerCase())));
    if (missing.length) log.warn('some permissions were not granted', { missing });
    save({
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? cached?.refreshToken,
      expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? '',
    });
  }

  async function refresh() {
    if (!cached?.refreshToken) throw new AuthRequiredError();
    const { ok, body } = await post('token', { grant_type: 'refresh_token', refresh_token: cached.refreshToken, scope });
    if (!ok) {
      // invalid_grant = revoked, expired or consent changed: a new sign-in is needed.
      log.warn('token refresh failed', { error: body.error, description: body.error_description?.split('\n')[0] });
      cached = null; // re-read the token file next time, so `npm run ms:login` recovers without a restart
      throw new AuthRequiredError(`Microsoft sign-in expired (${body.error ?? 'refresh failed'}): run \`npm run ms:login\``);
    }
    store(body);
  }

  return {
    hasToken: () => Boolean(cached?.refreshToken),
    grantedScopes: () => cached?.scope ?? '',

    async getAccessToken({ forceRefresh = false } = {}) {
      cached ??= load();
      if (!cached) throw new AuthRequiredError();
      if (forceRefresh || Date.now() > cached.expiresAt - EXPIRY_SKEW_MS) {
        refreshing ??= refresh().finally(() => { refreshing = null; });
        await refreshing;
      }
      return cached.accessToken;
    },

    // Interactive sign-in: shows a code to enter at microsoft.com/devicelogin.
    async deviceCodeLogin({ onPrompt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
      const start = await post('devicecode', { scope });
      if (!start.ok) {
        throw new Error(`Could not start sign-in: ${start.body.error_description?.split('\n')[0] ?? start.body.error ?? 'unknown error'}`);
      }
      const { device_code: deviceCode, message, interval = 5, expires_in: expiresIn = 900 } = start.body;
      onPrompt?.(message);

      let wait = interval * 1000;
      const deadline = Date.now() + expiresIn * 1000;
      while (Date.now() < deadline) {
        await sleep(wait);
        const { ok, body } = await post('token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        });
        if (ok) {
          store(body);
          return { scope: body.scope };
        }
        if (body.error === 'authorization_pending') continue;
        if (body.error === 'slow_down') { wait += 5000; continue; }
        throw new Error(`Sign-in failed: ${body.error}${body.error_description ? ` — ${body.error_description.split('\n')[0]}` : ''}`);
      }
      throw new Error('Sign-in timed out; run `npm run ms:login` again');
    },
  };
}
