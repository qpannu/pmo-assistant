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

// Comma-separated list, e.g. "Bug, Incident" → ['Bug', 'Incident'].
function list(name, fallback = []) {
  const raw = str(name);
  if (raw === '') return Object.freeze([...fallback]);
  return Object.freeze(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function loadConfig() {
  return Object.freeze({
    port: int('PORT', 3100, { min: 1, max: 65535 }),
    host: str('HOST', '127.0.0.1'),
    logLevel: str('LOG_LEVEL', 'info'),
    dbPath: str('DB_PATH', './data/pmo.db'),

    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    // Claude is used only to reason about the top three priorities, and only
    // when explicitly enabled — it is billed per call.
    priorityUseClaude: str('PRIORITY_USE_CLAUDE', 'false') === 'true',
    claudeModel: str('CLAUDE_MODEL', 'claude-opus-5-5'),
    // Briefings, questions and drafts. Off by default (billed per call).
    claudeEnabled: str('CLAUDE_ENABLED', 'false') === 'true',
    claudeDailyCallLimit: int('CLAUDE_DAILY_CALL_LIMIT', 40, { min: 0, max: 1000 }),
    // Optional text file about your projects/team, sent (and cached) with each Claude call.
    pmoContextFile: str('PMO_CONTEXT_FILE'),
    myName: str('MY_NAME'),

    // Notifications to you in Teams via a Teams Workflow webhook (secret URL).
    teamsWebhookUrl: str('TEAMS_WEBHOOK_URL'),
    briefingTimes: Object.freeze({
      morning: str('BRIEFING_MORNING', '08:00'),
      midday: str('BRIEFING_MIDDAY', '12:30'),
      eod: str('BRIEFING_EOD', '17:30'),
    }),
    // Days of week (0 = Sunday): weekdays by default.
    briefingDays: Object.freeze(list('BRIEFING_DAYS', ['1', '2', '3', '4', '5']).map(Number)),

    jira: Object.freeze({
      baseUrl: str('JIRA_BASE_URL').replace(/\/+$/, ''),
      email: str('JIRA_EMAIL'),
      apiToken: str('JIRA_API_TOKEN'),
      // Projects to watch for production bugs and releases (keys, e.g. OS,REST).
      // Issues assigned to / reported by / watched by me are tracked in every project.
      projects: list('JIRA_PROJECTS'),
      prodIssueTypes: list('JIRA_PROD_ISSUE_TYPES', ['Bug']),
      blockerPriorities: list('JIRA_BLOCKER_PRIORITIES', ['Highest', 'High']),
      // Optional: only count bugs carrying one of these labels as production bugs.
      prodLabels: list('JIRA_PROD_LABELS'),
      // A blocker-priority bug counts as a production blocker only if updated this recently.
      prodActiveDays: int('JIRA_PROD_ACTIVE_DAYS', 30, { min: 1, max: 3650 }),
      // An @mention counts as awaiting my reply only if it is this recent.
      replyWindowDays: int('JIRA_REPLY_WINDOW_DAYS', 14, { min: 1, max: 365 }),
      decisionLabels: list('JIRA_DECISION_LABELS', ['needs-decision']),
      decisionStatuses: list('JIRA_DECISION_STATUSES'),
      blockedStatuses: list('JIRA_BLOCKED_STATUSES', ['Blocked', 'On Hold']),
      releaseWindowDays: int('JIRA_RELEASE_WINDOW_DAYS', 14, { min: 1, max: 365 }),
      // Unreleased versions overdue by more than this are treated as abandoned.
      releaseOverdueDays: int('JIRA_RELEASE_OVERDUE_DAYS', 14, { min: 0, max: 365 }),
      fullSyncHours: int('JIRA_FULL_SYNC_HOURS', 24, { min: 1 }),
      maxIssuesPerSync: int('JIRA_MAX_ISSUES_PER_SYNC', 1000, { min: 10, max: 5000 }),
      // Watched issues count only if updated within this many days (0 = no limit).
      watcherActiveDays: int('JIRA_WATCHER_ACTIVE_DAYS', 90, { min: 0, max: 3650 }),
    }),

    ms: Object.freeze({
      tenantId: str('MS_TENANT_ID'),
      clientId: str('MS_CLIENT_ID'),
      tokenCachePath: str('MS_TOKEN_CACHE_PATH', './data/.ms-token.json'),
      outlookEnabled: str('MS_OUTLOOK_ENABLED', 'true') === 'true',
      teamsEnabled: str('MS_TEAMS_ENABLED', 'true') === 'true',
      // First sync looks back this far; later syncs are incremental.
      mailLookbackDays: int('MS_MAIL_LOOKBACK_DAYS', 14, { min: 1, max: 90 }),
      teamsLookbackDays: int('MS_TEAMS_LOOKBACK_DAYS', 7, { min: 1, max: 60 }),
      // A request older than this no longer counts as needing my response.
      replyWindowDays: int('MS_REPLY_WINDOW_DAYS', 7, { min: 1, max: 60 }),
      // Flag my own questions that got no answer after this many days.
      followUpAfterDays: int('MS_FOLLOWUP_AFTER_DAYS', 3, { min: 1, max: 30 }),
      // Optional Teams channels to watch, as "Team name/Channel name" (needs admin consent).
      teamsChannels: list('MS_TEAMS_CHANNELS'),
      maxMessagesPerSync: int('MS_MAX_MESSAGES_PER_SYNC', 500, { min: 10, max: 5000 }),
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

// Delegated Graph permissions, limited to what the enabled features need.
export function msScopes(ms) {
  const scopes = ['offline_access', 'User.Read'];
  if (ms.outlookEnabled) scopes.push('Mail.Read');
  if (ms.teamsEnabled) {
    scopes.push('Chat.Read');
    if (ms.teamsChannels.length) scopes.push('Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All');
  }
  return scopes;
}

export const config = loadConfig();
