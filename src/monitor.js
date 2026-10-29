// Basic monitoring: sync freshness, briefing delivery, notifications and
// Claude usage in one status object, plus a Teams alert when a sync keeps failing.

import { localToday } from './jira/classify.js';
import { notifyPendingAlerts } from './notify/teams.js';

const SOURCES = ['jira', 'outlook', 'teams'];
const STALE_FACTOR = 3; // stale after missing ~3 scheduled syncs

export function serviceStatus({ store, config, scheduler, notifier, claude, now = new Date() }) {
  const sources = {};
  for (const name of SOURCES) {
    if (!scheduler.has(name)) {
      sources[name] = { enabled: false };
      continue;
    }
    const s = store.getSyncState(name);
    const minutes = s?.last_success_at ? Math.round((now - Date.parse(s.last_success_at)) / 60_000) : null;
    const limit = config.syncMinutes[name] * STALE_FACTOR + 5;
    sources[name] = {
      enabled: true,
      lastSuccessAt: s?.last_success_at ?? null,
      minutesSinceSuccess: minutes,
      lastError: s?.last_error ?? null,
      stale: minutes === null ? Boolean(s?.last_error) : minutes > limit,
    };
  }

  const today = localToday(now);
  const briefings = store.listBriefings(today).map((b) => ({ kind: b.kind, method: b.method, sentAt: b.sent_at, error: b.send_error }));
  const usage = store.llmUsageSince(new Date(`${today}T00:00:00`).toISOString());
  const pendingNotifications = store.alertsToNotify().length;

  const problems = [
    ...Object.entries(sources).filter(([, v]) => v.stale).map(([k]) => `${k} sync is stale`),
    ...briefings.filter((b) => b.error && !b.sentAt).map((b) => `${b.kind} briefing not delivered`),
    ...(pendingNotifications && notifier.configured ? [`${pendingNotifications} alert(s) waiting to be delivered`] : []),
  ];

  return {
    status: problems.length ? 'degraded' : 'ok',
    problems,
    sources,
    briefingsToday: briefings,
    notifications: { teamsConfigured: notifier.configured, activeAlerts: store.listActiveAlerts().length, pendingDelivery: pendingNotifications },
    drafts: { pendingReview: store.listDrafts('pending').length, approvedNotSent: store.listDrafts('approved').length },
    claude: { enabled: claude.enabled, model: claude.model, dailyCallLimit: config.claudeDailyCallLimit, today: usage },
  };
}

// Raises (once per source per day) and delivers an alert for failing syncs.
export async function checkAndAlert({ store, config, scheduler, notifier, claude, now = new Date() }) {
  const status = serviceStatus({ store, config, scheduler, notifier, claude, now });
  for (const [name, s] of Object.entries(status.sources)) {
    if (!s.stale) continue;
    store.raiseAlert({
      dedupeKey: `monitor:${name}:${localToday(now)}`,
      severity: 'warning',
      title: `${name} sync is failing or stale`,
      detail: s.lastError ? `Last error: ${s.lastError}` : `No successful sync for ${s.minutesSinceSuccess ?? '?'} minutes`,
    });
  }
  await notifyPendingAlerts(store, notifier);
  return status;
}
