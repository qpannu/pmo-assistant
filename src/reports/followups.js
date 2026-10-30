// Optional Claude pass over a report's rule-based follow-ups: re-orders them
// and may tighten their wording, using only the compact facts given. It picks
// follow-ups by number, so each keeps its rule, keys and feedback ref; it can't
// add follow-ups, and a rewording that cites an issue key not in the original is
// ignored. It never changes counts. Without Claude, the list is used as is.

import { logger } from '../logger.js';

const log = logger.child({ component: 'reports' });

const SYSTEM = `You prioritise follow-ups for a senior program manager from a Jira report.
Use ONLY the facts and follow-ups provided. Never invent issue keys, numbers, people or dates.
Return the follow-ups worth doing first, by their index, ordered by delivery impact (blockers and
release risk first). You may shorten a follow-up's text (under 30 words) and say who to talk to when
an owner is given. Return at most 7. Respect "note" fields: they record the manager's own feedback.`;

const SCHEMA = {
  type: 'object',
  properties: {
    followUps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, text: { type: 'string' } },
        required: ['index', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['followUps'],
  additionalProperties: false,
};

const KEY_RX = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export async function refineFollowUps({ claude, purpose, facts, followUps }) {
  if (!claude?.enabled || !followUps.length) return { followUps, source: 'rules' };
  try {
    const { json } = await claude.complete({
      purpose,
      system: SYSTEM,
      user: JSON.stringify({ facts, followUps: followUps.map((f, index) => ({ index, text: f.text, note: f.note ?? undefined })) }),
      schema: SCHEMA,
      effort: 'low',
      maxTokens: 2000,
    });
    const picked = new Set();
    const ordered = [];
    for (const { index, text } of json?.followUps ?? []) {
      const f = followUps[index];
      if (!f || picked.has(index)) continue;
      picked.add(index);
      const allowed = new Set(f.text.match(KEY_RX) ?? []);
      const keepsFacts = (text.match(KEY_RX) ?? []).every((k) => allowed.has(k));
      ordered.push(keepsFacts && text.trim() ? { ...f, text: text.trim() } : f);
    }
    if (!ordered.length) return { followUps, source: 'rules' };
    // Anything Claude didn't pick stays, after its choices, so nothing silently disappears.
    return { followUps: [...ordered, ...followUps.filter((_, i) => !picked.has(i))], source: 'claude' };
  } catch (err) {
    log.warn('follow-up refinement skipped', { purpose, error: err.message });
    return { followUps, source: 'rules' };
  }
}
