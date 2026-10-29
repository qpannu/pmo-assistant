// Notifications to *you* in Microsoft Teams via a Teams Workflow webhook
// ("Post to a chat when a webhook request is received"). No Entra app needed.
// The webhook URL is a secret (it embeds a signature) — keep it in .env only.
// Without a URL, notifications are logged instead (dry run).

import { logger } from '../logger.js';
import { truncate } from '../text.js';

const log = logger.child({ component: 'teams-notify' });
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TEXT = 6000;

export function buildCard({ title, body, severity = 'info', facts = [], links = [] }) {
  const content = [
    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true, color: severity === 'critical' ? 'Attention' : 'Default' },
    { type: 'TextBlock', text: truncate(body, MAX_TEXT), wrap: true },
  ];
  if (facts.length) content.push({ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: String(t), value: String(v) })) });
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: content,
        actions: links.filter((l) => /^https:\/\//.test(l.url)).slice(0, 4).map((l) => ({ type: 'Action.OpenUrl', title: truncate(l.title, 40), url: l.url })),
      },
    }],
  };
}

export function createTeamsNotifier({ webhookUrl, fetchImpl = fetch, retryDelayMs = 2000 }) {
  if (webhookUrl && !/^https:\/\//.test(webhookUrl)) throw new Error('TEAMS_WEBHOOK_URL must be an https URL');

  return {
    configured: Boolean(webhookUrl),

    async send(message) {
      if (!webhookUrl) {
        log.info('teams notification (dry run — TEAMS_WEBHOOK_URL not set)', { title: message.title });
        return { dryRun: true };
      }
      const payload = JSON.stringify(buildCard(message));
      for (let attempt = 1; ; attempt++) {
        let error;
        let retryable;
        try {
          const res = await fetchImpl(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: AbortSignal.timeout(20_000),
          });
          if (res.ok) return { delivered: true, status: res.status };
          error = new Error(`Teams webhook returned HTTP ${res.status}`);
          retryable = RETRYABLE.has(res.status);
        } catch (err) {
          error = new Error(`Teams webhook request failed: ${err.message}`);
          retryable = true; // network error or timeout
        }
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        log.warn('teams webhook failed, retrying', { attempt, error: error.message });
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    },
  };
}

// Delivers alerts raised by the priority engine or the monitor. Each alert is
// sent once; failures are retried on later runs (up to 5 attempts).
export async function notifyPendingAlerts(store, notifier) {
  const sent = [];
  for (const alert of store.alertsToNotify()) {
    const links = alert.action_item_id
      ? store.listActionSources(alert.action_item_id).filter((s) => s.url).map((s) => ({ title: `Open in ${cap(s.source)}`, url: s.url }))
      : [];
    try {
      await notifier.send({
        title: `${alert.severity === 'critical' ? '🔴 Urgent' : '⚠️ Alert'}: ${alert.title}`,
        body: alert.detail ? `**Next:** ${alert.detail}` : '',
        severity: alert.severity,
        links,
      });
      store.markAlertNotified(alert.id);
      sent.push(alert.id);
    } catch (err) {
      store.markAlertNotifyFailed(alert.id, err.message);
      log.error('alert notification failed', { alertId: alert.id, error: err.message });
    }
  }
  return sent;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
