// Your verdicts on reported risks / follow-ups, by their short ref.
// valid     → keep showing it, ranked higher
// dismissed → hide it until the facts behind it change
// resolved  → you consider it handled; if Jira still shows it, the report says so
// clear     → forget the verdict
// Only the report's own ordering and visibility change; Jira is never touched.

export const VERDICTS = ['valid', 'dismissed', 'resolved'];

export class FeedbackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
  }
}

export function setVerdict(store, ref, verdict, note = null) {
  const r = String(ref ?? '').trim().toLowerCase().replace(/^#|^ref\s*/, '');
  const v = verdict === 'clear' || verdict === null ? null : String(verdict ?? '').toLowerCase();
  if (v !== null && !VERDICTS.includes(v)) throw new FeedbackError(`Verdict must be one of ${VERDICTS.join(', ')} or clear`);
  const row = store.setRiskVerdict(r, v, note ? String(note).slice(0, 500) : null);
  if (!row) throw new FeedbackError(`No reported risk with ref ${r}`, 404);
  return row;
}

export function recentRisks(store, { report = null, days = 7, now = new Date() } = {}) {
  return store.listRiskItems({ report, since: new Date(now.getTime() - days * 86_400_000).toISOString() });
}
