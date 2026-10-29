// Read-only Jira Cloud REST client. It can only issue GET requests — there is
// deliberately no code path that creates, edits or transitions anything.

import { logger } from '../logger.js';

const log = logger.child({ component: 'jira' });

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRYABLE = new Set([429, 502, 503, 504]);

export class JiraError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createJiraClient({ baseUrl, email, apiToken }, { fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  if (!baseUrl || !email || !apiToken) throw new Error('Jira client needs baseUrl, email and apiToken');
  const root = baseUrl.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  let me = null;

  async function get(path, query = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${root}${path}${qs.size ? `?${qs}` : ''}`;

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          log.warn('request error, retrying', { path, attempt: attempt + 1, error: err.message });
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new JiraError(`Jira request failed: ${err.message}`, { path });
      }

      if (res.ok) return res.json();

      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt;
        log.warn('jira throttled or unavailable, retrying', { path, status: res.status, waitMs: wait });
        await sleep(wait);
        continue;
      }

      throw new JiraError(describeError(res.status, await res.text().catch(() => '')), { status: res.status, path });
    }
  }

  return {
    // Current user (cached for the life of the process).
    async myself() {
      me ??= await get('/rest/api/3/myself');
      return me;
    },

    // One page of the enhanced JQL search (token-based pagination).
    searchPage({ jql, fields, maxResults = 100, nextPageToken }) {
      return get('/rest/api/3/search/jql', { jql, fields: fields.join(','), maxResults, nextPageToken });
    },

    // All pages up to `limit` issues.
    async search({ jql, fields, limit = 500, pageSize = 100 }) {
      const issues = [];
      let nextPageToken;
      do {
        const page = await this.searchPage({ jql, fields, maxResults: Math.min(pageSize, limit - issues.length), nextPageToken });
        issues.push(...(page.issues ?? []));
        nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
      } while (nextPageToken && issues.length < limit);
      const truncated = Boolean(nextPageToken);
      if (truncated) log.warn('search truncated at limit', { limit });
      return { issues, truncated };
    },

    projectVersions(projectKey) {
      return get(`/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`);
    },

    browseUrl: (key) => `${root}/browse/${key}`,
    versionUrl: (projectKey, versionId) => `${root}/projects/${projectKey}/versions/${versionId}`,
  };
}

function describeError(status, body) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join('; ');
  } catch {
    detail = body.slice(0, 300);
  }
  const hint = {
    401: 'check JIRA_EMAIL and JIRA_API_TOKEN',
    403: 'the account lacks permission for this resource',
    404: 'check JIRA_BASE_URL or the project key',
    400: 'check the JQL-related settings (project keys, issue types, priorities)',
  }[status];
  return `Jira HTTP ${status}${detail ? `: ${detail}` : ''}${hint ? ` (${hint})` : ''}`;
}
