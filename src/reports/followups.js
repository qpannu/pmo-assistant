// Optional Claude pass over a report's rule-based follow-ups: re-orders and
// tightens them using only the compact facts given. It can't add Jira facts —
// any follow-up citing an issue key that isn't in the input is dropped — and
// it never changes counts. Without Claude, the rule-based list is used as is.

import { logger } from '../logger.js';

const log = logger.child({ component: 'reports' });

const SYSTEM = `You prioritise follow-ups for a senior program manager from a Jira report.
Use ONLY the facts and follow-ups provided. Never invent issue keys, numbers, people or dates.
Order by delivery impact (blockers and release risk first), merge duplicates, keep each under 30 words,
and say who to talk to when an owner is given. Return at most 7.`;

const SCHEMA = {
  type: 'object',
  properties: { followUps: { type: 'array', items: { type: 'string' } } },
  required: ['followUps'],
  additionalProperties: false,
};

const KEY_RX = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export async function refineFollowUps({ claude, purpose, facts, followUps }) {
  if (!claude?.enabled || !followUps.length) return { followUps, source: 'rules' };
  const allowed = new Set(JSON.stringify({ facts, followUps }).match(KEY_RX) ?? []);
  try {
    const { json } = await claude.complete({
      purpose,
      system: SYSTEM,
      user: JSON.stringify({ facts, followUps: followUps.map((f) => f.text) }),
      schema: SCHEMA,
      effort: 'low',
      maxTokens: 2000,
    });
    const refined = (json?.followUps ?? [])
      .filter((t) => (t.match(KEY_RX) ?? []).every((k) => allowed.has(k)))
      .map((text) => ({ rule: 'claude', keys: text.match(KEY_RX) ?? [], text }));
    return refined.length ? { followUps: refined, source: 'claude' } : { followUps, source: 'rules' };
  } catch (err) {
    log.warn('follow-up refinement skipped', { purpose, error: err.message });
    return { followUps, source: 'rules' };
  }
}
