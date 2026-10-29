// The PMO priority engine: one ranked list across Jira, Outlook and Teams.
//
// Ordinary code does all the routine work — scoring, categorising,
// deduplication (already done when action items are derived), evidence and
// next actions. Claude is only consulted, optionally, to reason about which
// three items matter most, and only when that candidate set has changed.

import { logger } from '../logger.js';
import { CATEGORIES, categorize, evidenceFor, nextActionFor, scoreAction } from './score.js';

const log = logger.child({ component: 'priority' });
const TOP_N = 3;

function rankAll(store, now) {
  const releases = new Map(
    store.listItems({ source: 'jira', kind: 'release' })
      .filter((r) => r.data.tracked)
      .map((r) => [r.data.id, r.data]),
  );

  return store.listOpenActions().map((action) => {
    const sources = store.listActionSourceItems(action.id);
    const scored = scoreAction(action, sources, { releases }, now);
    const category = categorize(action, scored);
    return {
      id: action.id,
      dedupeKey: action.dedupe_key,
      type: action.type,
      title: action.title,
      project: action.project,
      priority: action.priority,
      dueAt: action.due_at,
      status: action.status,
      score: scored.score,
      category,
      reasons: scored.reasons,
      sources: evidenceFor(sources),
      nextAction: nextActionFor(action, sources, scored.flags),
      firstItemId: sources[0]?.id ?? null,
    };
  }).sort((a, b) => b.score - a.score
    || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')
    || a.id - b.id);
}

function rulesTopThree(ranked) {
  return ranked.slice(0, TOP_N).map((item) => ({
    id: item.id,
    title: item.title,
    why: item.reasons.slice(0, 2).map((r) => r.label).join('; '),
    nextAction: item.nextAction,
  }));
}

// options.raiseAlerts: record (deduplicated) alerts for critical items.
// options.reasoner: optional async (candidates) => topThree, e.g. Claude.
export async function runPriorityEngine(store, { now = new Date(), raiseAlerts = false, reasoner = null } = {}) {
  const ranked = rankAll(store, now);

  // Persist rankings; unchanged rows are not rewritten.
  let changed = 0;
  store.transaction(() => {
    for (const item of ranked) {
      if (store.saveActionRanking(item.id, { score: item.score, category: item.category, reasons: item.reasons })) changed++;
    }
  });

  // Each critical item alerts once; repeated runs find the alert already raised.
  const newAlerts = [];
  if (raiseAlerts) {
    for (const item of ranked.filter((i) => i.category === CATEGORIES.CRITICAL)) {
      const r = store.raiseAlert({
        dedupeKey: `critical:${item.dedupeKey}`,
        itemId: item.firstItemId,
        actionItemId: item.id,
        severity: 'critical',
        title: item.title,
        detail: item.nextAction,
      });
      if (r.created) newAlerts.push({ alertId: r.id, actionId: item.id, title: item.title, nextAction: item.nextAction });
    }
  }

  let topThree = { method: 'rules', items: rulesTopThree(ranked) };
  if (reasoner && ranked.length) {
    try {
      const picked = await reasoner(ranked);
      if (picked) topThree = picked;
    } catch (err) {
      log.warn('top-three reasoning failed; using rule-based ranking', { error: err.message });
    }
  }

  const by = (category) => ranked.filter((i) => i.category === category);
  const report = {
    generatedAt: now.toISOString(),
    counts: {
      total: ranked.length,
      critical: by(CATEGORIES.CRITICAL).length,
      waitingOnMe: by(CATEGORIES.WAITING).length,
      releaseRisks: by(CATEGORIES.RELEASES).length,
      followUps: by(CATEGORIES.FOLLOW_UPS).length,
    },
    critical: by(CATEGORIES.CRITICAL),
    waitingOnMe: by(CATEGORIES.WAITING),
    releaseRisks: by(CATEGORIES.RELEASES),
    followUps: by(CATEGORIES.FOLLOW_UPS),
    topThree,
    newAlerts,
  };
  log.info('priorities ranked', { ...report.counts, rankingChanges: changed, newAlerts: newAlerts.length, topThree: topThree.method });
  return report;
}
