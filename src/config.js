// Central configuration, read once from environment variables (loaded from .env
// by `node --env-file-if-exists`). Integration credentials are optional here;
// each integration calls requireConfig() for what it needs when it starts.

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(name);
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Config ${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

export function loadConfig() {
  return Object.freeze({
    port: int('PORT', 3100, { min: 1, max: 65535 }),
    host: str('HOST', '127.0.0.1'),
    logLevel: str('LOG_LEVEL', 'info'),
    dbPath: str('DB_PATH', './data/pmo.db'),

    anthropicApiKey: str('ANTHROPIC_API_KEY'),

    jira: Object.freeze({
      baseUrl: str('JIRA_BASE_URL').replace(/\/+$/, ''),
      email: str('JIRA_EMAIL'),
      apiToken: str('JIRA_API_TOKEN'),
    }),

    ms: Object.freeze({
      tenantId: str('MS_TENANT_ID'),
      clientId: str('MS_CLIENT_ID'),
      tokenCachePath: str('MS_TOKEN_CACHE_PATH', './data/.msal-cache.json'),
    }),

    syncMinutes: Object.freeze({
      jira: int('SYNC_INTERVAL_JIRA', 10, { min: 1 }),
      outlook: int('SYNC_INTERVAL_OUTLOOK', 5, { min: 1 }),
      teams: int('SYNC_INTERVAL_TEAMS', 5, { min: 1 }),
    }),
  });
}

// Throws with the names of any missing settings, e.g.
// requireConfig(config, ['jira.baseUrl', 'jira.email', 'jira.apiToken']).
export function requireConfig(config, paths) {
  const missing = paths.filter((p) => !p.split('.').reduce((o, k) => o?.[k], config));
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}. Set them in .env (see .env.example).`);
  }
}

// Which integrations have credentials present — safe to log, never exposes values.
export function integrationStatus(config) {
  return {
    claude: Boolean(config.anthropicApiKey),
    jira: Boolean(config.jira.baseUrl && config.jira.email && config.jira.apiToken),
    microsoft: Boolean(config.ms.tenantId && config.ms.clientId),
  };
}

export const config = loadConfig();
