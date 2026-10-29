// Optional Claude step: choose the top three priorities with reasoning.
// Only the top candidates (already scored and evidenced by rules) are sent,
// and the result is cached until that candidate set changes.

import { contentHash } from '../store.js';
import { truncate } from '../text.js';

const CACHE_KEY = 'priority_reasoning';
const MAX_CANDIDATES = 8;

const SYSTEM = `You help a senior program manager decide what to work on first.
You receive candidate action items gathered from Jira, Outlook and Teams. Each has a rule-based score, the reasons behind it, evidence quoted from the source, and a suggested next action.
Pick the three items that most deserve attention today, weighing production impact, release deadlines, people blocked waiting on the manager, and business impact. Treat the scores as a guide: depart from them only when the evidence gives a reason, and say what that reason is.
For each pick, write one or two sentences that cite the evidence. Then write a one-sentence summary of the day's focus.`;

const SCHEMA = {
  type: 'object',
  properties: {
    top: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, why: { type: 'string' } },
        required: ['id', 'why'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['top', 'summary'],
  additionalProperties: false,
};

export function toCandidates(ranked, n = MAX_CANDIDATES) {
  return ranked.slice(0, n).map((i) => ({
    id: i.id,
    title: truncate(i.title, 120),
    category: i.category,
    score: i.score,
    dueAt: i.dueAt,
    reasons: i.reasons.slice(0, 3).map((r) => r.label),
    evidence: i.sources.map((s) => `${s.system}: ${truncate(s.text, 200)}`),
    suggestedNextAction: i.nextAction,
  }));
}

export function createClaudeReasoner({ store, claude }) {
  return async function reasonTopThree(ranked) {
    const candidates = toCandidates(ranked);
    const hash = contentHash(candidates.map(({ id, score, category, reasons, evidence }) => ({ id, score, category, reasons, evidence })));

    const cached = JSON.parse(store.getSyncState(CACHE_KEY)?.cursor ?? 'null');
    if (cached?.hash === hash) return { ...cached.result, method: 'claude-cached' };

    const { json } = await claude.complete({
      purpose: 'top_three',
      system: SYSTEM,
      user: JSON.stringify({ today: new Date().toISOString().slice(0, 10), candidates }),
      effort: 'medium',
      schema: SCHEMA,
    });

    const byId = new Map(ranked.map((i) => [i.id, i]));
    const items = json.top
      .filter((p) => byId.has(p.id))
      .slice(0, 3)
      .map((p) => ({ id: p.id, title: byId.get(p.id).title, why: p.why, nextAction: byId.get(p.id).nextAction }));
    if (!items.length) throw new Error('Claude returned no valid item ids');

    const result = { method: 'claude', items, summary: json.summary };
    store.saveSyncSuccess(CACHE_KEY, JSON.stringify({ hash, result }));
    return result;
  };
}
