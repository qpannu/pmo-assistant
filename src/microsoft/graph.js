// Read-only Microsoft Graph client: GET requests only. Handles paging, delta
// links, throttling (429/503 with Retry-After) and one token refresh on 401.

import { logger } from '../logger.js';

const log = logger.child({ component: 'graph' });
export const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;
const RETRYABLE = new Set([429, 502, 503, 504]);

export class GraphError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGraphClient(auth, { fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  let me = null;

  // `pathOrUrl` is a /v1.0 path or a full nextLink/deltaLink returned by Graph.
  async function get(pathOrUrl, { query, headers = {} } = {}) {
    let url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    if (!url.startsWith(GRAPH)) throw new Error('Refusing to call a non-Graph URL');
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
      url += (url.includes('?') ? '&' : '?') + qs.toString().replace(/\+/g, '%20');
    }
    const path = new URL(url).pathname;

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await auth.getAccessToken();
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new GraphError(`Graph request failed: ${err.message}`, { path });
      }

      if (res.ok) return res.json();

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await auth.getAccessToken({ forceRefresh: true });
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt;
        log.warn('graph throttled or unavailable, retrying', { path, status: res.status, waitMs: wait });
        await sleep(wait);
        continue;
      }

      const body = await res.json().catch(() => ({}));
      const code = body.error?.code;
      const hint = {
        401: 'sign in again with `npm run ms:login`',
        403: 'a permission is missing or needs admin consent (see README)',
      }[res.status];
      throw new GraphError(
        `Graph HTTP ${res.status}${code ? ` ${code}` : ''}: ${body.error?.message ?? 'request failed'}${hint ? ` (${hint})` : ''}`,
        { status: res.status, code, path },
      );
    }
  }

  return {
    get,

    async me() {
      me ??= await get('/me', { query: { $select: 'id,displayName,mail,userPrincipalName' } });
      return me;
    },

    // Follows nextLinks up to `limit` items. Returns the final deltaLink (if any)
    // or, when the limit is hit first, the nextLink to resume from next time.
    async collect(pathOrUrl, { query, headers, limit = 500, stopWhen } = {}) {
      const items = [];
      let url = pathOrUrl;
      let first = true;
      while (url) {
        const page = await get(url, first ? { query, headers } : { headers });
        first = false;
        for (const v of page.value ?? []) {
          if (stopWhen?.(v)) return { items, deltaLink: null, nextLink: null, stopped: true };
          items.push(v);
        }
        if (page['@odata.deltaLink']) return { items, deltaLink: page['@odata.deltaLink'], nextLink: null };
        url = page['@odata.nextLink'] ?? null;
        if (url && items.length >= limit) return { items, deltaLink: null, nextLink: url, truncated: true };
      }
      return { items, deltaLink: null, nextLink: null };
    },
  };
}
