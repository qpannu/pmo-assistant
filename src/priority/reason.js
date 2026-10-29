// Optional Claude step: choose the top three priorities with reasoning.
// Only the top candidates (already scored and evidenced by rules) are sent,
// and the result is cached until that candidate set changes.

import { contentHash } from '../store.js';
import { truncate } from '../text.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'priority-claude' });
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

function toCandidates(ranked) {
  return ranked.slice(0, MAX_CANDIDATES).map((i) => ({
    id: i.id,
    title: i.title,
    category: i.category,
    score: i.score,
    dueAt: i.dueAt,
    reasons: i.reasons.map((r) => r.label),
    evidence: i.sources.map((s) => `${s.system}: ${truncate(s.text, 240)}`),
    suggestedNextAction: i.nextAction,
  }));
}

// `client` is injectable for tests; by default the official SDK is loaded lazily.
export function createClaudeReasoner({ store, apiKey, model, client = null }) {
  let sdkClient = client;

  return async function reasonTopThree(ranked) {
    const candidates = toCandidates(ranked);
    const hash = contentHash(candidates.map(({ id, score, category, reasons, evidence }) => ({ id, score, category, reasons, evidence })));

    const cached = JSON.parse(store.getSyncState(CACHE_KEY)?.cursor ?? 'null');
    if (cached?.hash === hash) return { ...cached.result, method: 'claude-cached' };

    if (!sdkClient) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      sdkClient = new Anthropic({ apiKey });
    }

    const response = await sdkClient.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ today: new Date().toISOString().slice(0, 10), candidates }) }],
    });

    if (response.stop_reason === 'refusal') throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error(`No text in Claude response (stop_reason ${response.stop_reason})`);

    const parsed = JSON.parse(text);
    const byId = new Map(ranked.map((i) => [i.id, i]));
    const items = parsed.top
      .filter((p) => byId.has(p.id))
      .slice(0, 3)
      .map((p) => ({ id: p.id, title: byId.get(p.id).title, why: p.why, nextAction: byId.get(p.id).nextAction }));
    if (!items.length) throw new Error('Claude returned no valid item ids');

    const result = { method: 'claude', items, summary: parsed.summary };
    store.saveSyncSuccess(CACHE_KEY, JSON.stringify({ hash, result }));
    log.info('top three reasoned by Claude', {
      model: response.model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
    return result;
  };
}
