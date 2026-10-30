// Makes the reports more useful over time — with counters and rules you can
// read, not model training:
//  • every follow-up gets a short ref (e.g. a1b2c3) you can mark valid,
//    dismissed or resolved (npm run risk -- <ref> dismissed "why");
//  • dismissed items stay hidden until the facts behind them change;
//  • "valid" items and rules you rarely dismiss rank higher; rules you mostly
//    dismiss rank lower — each item says why it is where it is;
//  • unchanged repeats collapse into one line (urgent ones always show);
//  • rules can be switched off or re-weighted in REPORT_RULES_FILE;
//  • recurring blockers and reopened issues are found in past snapshots.
// It never changes Jira, and never overrides Jira facts — only ordering,
// visibility and notes on the inferred follow-ups.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { logger } from '../logger.js';

const log = logger.child({ component: 'learning' });

// Starting weight per rule (higher = shown earlier). Override in REPORT_RULES_FILE.
export const DEFAULT_WEIGHTS = Object.freeze({
  critical: 95, 'critical-bug': 85, 'urgent-bug': 85, blocker: 80, blocked: 80, 'due-soon': 80, 'epic-due-soon': 75,
  'date-passed': 70, 'epic-overdue': 70, dependency: 55, stalled: 55, stale: 50, 'not-started': 50, 'no-owner': 45,
  'chronic-carryover': 45, 'long-wait': 40, unscheduled: 40, 'epic-inconsistent': 40, 'epic-empty': 35,
  unprioritised: 35, concentration: 35, 'no-date': 30, 'no-dates': 30, bucket: 25, 'complete-unreleased': 15,
  dormant: 15, 'multi-version': 15, 'no-component': 10, unestimated: 10,
});

export const DEFAULT_RULES = Object.freeze({
  weights: DEFAULT_WEIGHTS,
  disabled: [],              // e.g. ["scrum:unestimated", "releases:multi-version"] or a bare rule name
  collapseUnchanged: true,   // repeats with unchanged facts → one line
  alwaysShowScore: 75,       // never collapse items scoring at least this
  validBoost: 30,            // you marked it valid
  repeatBoost: 2,            // per time seen, up to 10 times (it keeps coming back)
  dismissPenalty: 20,        // rule types you mostly dismiss…
  dismissMinVerdicts: 3,     // …after at least this many verdicts on that rule
  chronicBlockedDays: 5,     // blocked on this many daily snapshots → chronic
  recurrenceDays: 30,        // history window for recurring blockers / reopened issues
});

// Reads REPORT_RULES_FILE (JSON) on top of the defaults. A bad file is reported, not fatal.
export function loadLearningRules(path) {
  if (!path || !existsSync(path)) return { ...DEFAULT_RULES, source: 'defaults' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      ...DEFAULT_RULES,
      ...raw,
      weights: { ...DEFAULT_WEIGHTS, ...(raw.weights ?? {}) },
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
      source: path,
    };
  } catch (err) {
    log.warn('report rules file unreadable; using defaults', { path, error: err.message });
    return { ...DEFAULT_RULES, source: 'defaults', error: `${path}: ${err.message}` };
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Only figures that change because time passes ("open 12 d", "3 day(s) ago",
// "idle 49d", "in 5 working days") are left out of the fingerprint, so the same
// facts keep the same fingerprint day to day. Counts, dates, keys, statuses and
// owners stay in: if any of those change, the facts have changed.
export function normalizeFacts(text) {
  return String(text)
    .replace(/\b\d+(\.\d+)?\s*(working days?|day\(s\)|days?|d)(?![A-Za-z])/gi, '#d')
    .replace(/\b\d+(\.\d+)?d\b/g, '#d')
    .replace(/\s+/g, ' ')
    .trim();
}

// A follow-up about one or two issues is identified by them. One about a group
// ("Chase or close 26 issues…") keeps a single identity per rule (and subject,
// e.g. the initiative), so a verdict survives the group changing; the change in
// membership shows up as "facts changed" instead.
export function riskIdentity(report, f) {
  const keys = [...new Set(f.keys ?? [])].sort();
  const group = keys.length > 2;
  const riskId = group ? `${report}:${f.rule}:${f.subject ?? 'group'}` : `${report}:${f.rule}:${keys.join(',') || f.subject || ''}`;
  const facts = normalizeFacts(f.text) + (group ? `|${keys.join(',')}` : '');
  return { riskId, ref: sha(riskId).slice(0, 6), fingerprint: sha(facts).slice(0, 12) };
}

const isDisabled = (rules, report, rule) => rules.disabled.includes(`${report}:${rule}`) || rules.disabled.includes(rule);

// Applies feedback, recurrence and weights to one list of follow-ups.
// Returns { followUps (to show), unchanged, suppressed, disabled, penalised }.
export function applyLearning({ store, report, followUps, rules = DEFAULT_RULES, now = new Date(), save = true }) {
  const at = now.toISOString();
  const stats = store.riskVerdictStats(report);
  const penalised = Object.entries(stats)
    .filter(([, s]) => {
      const total = s.valid + s.dismissed + s.resolved;
      return total >= rules.dismissMinVerdicts && s.dismissed / total >= 0.5;
    })
    .map(([rule]) => rule);

  const out = { followUps: [], unchanged: [], suppressed: [], disabled: [], penalised };
  const scored = [];
  for (const f of followUps) {
    if (isDisabled(rules, report, f.rule)) { out.disabled.push(f); continue; }
    const id = riskIdentity(report, f);
    const before = save
      ? store.recordRiskSeen({ ...id, report, rule: f.rule, keys: f.keys, text: f.text, at })
      : store.getRiskItem(id.ref);
    const status = !before ? 'new' : before.fingerprint !== id.fingerprint ? 'changed' : 'unchanged';
    const why = [];
    let score = rules.weights[f.rule] ?? 50;
    why.push(`rule ${f.rule} (${score})`);
    // Earlier days it was raised on (re-runs on the same day don't count).
    const earlierDays = before ? before.times_seen - (before.last_seen.slice(0, 10) === at.slice(0, 10) ? 1 : 0) : 0;
    if (earlierDays > 0) { score += Math.min(earlierDays, 10) * rules.repeatBoost; why.push(`raised on ${earlierDays} earlier day(s) since ${before.first_seen.slice(0, 10)}`); }
    if (penalised.includes(f.rule)) { score -= rules.dismissPenalty; why.push('you usually dismiss this kind'); }

    let note = null;
    const v = before?.verdict ?? null;
    const sameFacts = v && before.verdict_fingerprint === id.fingerprint;
    if (v === 'dismissed' && sameFacts) {
      out.suppressed.push({ ...f, ref: id.ref, verdictAt: before.verdict_at, verdictNote: before.verdict_note });
      continue;
    }
    if (v === 'dismissed') note = `you dismissed this on ${before.verdict_at.slice(0, 10)}; the facts have changed since`;
    if (v === 'resolved') note = sameFacts ? `you marked this resolved on ${before.verdict_at.slice(0, 10)}, but Jira still shows it` : `marked resolved on ${before.verdict_at.slice(0, 10)}; it has come back with different facts`;
    if (v === 'valid') { score += rules.validBoost; why.push('you confirmed it'); note = `✔ confirmed ${before.verdict_at.slice(0, 10)}`; }

    scored.push({ ...f, ref: id.ref, status, score, why, note, firstSeen: before?.first_seen ?? at });
  }

  scored.sort((a, b) => b.score - a.score);
  for (const f of scored) {
    const collapse = rules.collapseUnchanged && f.status === 'unchanged' && !f.note && f.score < rules.alwaysShowScore;
    (collapse ? out.unchanged : out.followUps).push(f);
  }
  return out;
}

// Map of issue key → phase from any report snapshot (all store [phase, …] arrays).
function phasesIn(data) {
  const out = {};
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && /^[A-Z][A-Z0-9]+-\d+$/.test(k)) out[k] = v[0];
      else if (!Array.isArray(v)) walk(v);
    }
  };
  walk(data);
  return out;
}

// One snapshot per day (the last one), oldest first.
function dailySnapshots(store, report, scope, now, days) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const byDay = new Map();
  for (const s of store.listReportSnapshots(report, scope, since)) byDay.set(s.taken_at.slice(0, 10), s);
  return [...byDay.values()];
}

// Issues blocked again after being unblocked, or blocked on many days.
export function recurringBlockers({ store, report, scope, now = new Date(), rules = DEFAULT_RULES }) {
  const days = dailySnapshots(store, report, scope, now, rules.recurrenceDays).map((s) => phasesIn(s.data));
  const keys = new Set(days.flatMap((d) => Object.keys(d)));
  const out = [];
  for (const key of keys) {
    let episodes = 0;
    let blockedDays = 0;
    let prev = false;
    for (const d of days) {
      if (!(key in d)) { prev = false; continue; }
      const b = d[key] === 'blocked';
      if (b) blockedDays++;
      if (b && !prev) episodes++;
      prev = b;
    }
    const current = days.at(-1)?.[key] === 'blocked';
    if (episodes >= 2 || (current && blockedDays >= rules.chronicBlockedDays)) out.push({ key, episodes, blockedDays, current });
  }
  return out.sort((a, b) => b.episodes - a.episodes || b.blockedDays - a.blockedDays);
}

// Keys that were in an earlier snapshot (within the window) but not the last one: reopened if back now.
export function reopened({ store, report, scope, keys, now = new Date(), rules = DEFAULT_RULES }) {
  const snaps = dailySnapshots(store, report, scope, now, rules.recurrenceDays).map((s) => phasesIn(s.data));
  if (snaps.length < 2) return [];
  const last = snaps.at(-1);
  const earlier = snaps.slice(0, -1);
  return keys.filter((k) => !(k in last) && earlier.some((d) => k in d));
}

// ─── Rendering helpers shared by all reports ──────────────────────────────────
export function followUpLine(f) {
  const tag = f.status === 'new' ? '🆕 ' : f.status === 'changed' ? '🔄 ' : '';
  return `- ${tag}${f.text}${f.note ? ` — ${f.note}` : ''}${f.ref ? ` · ref ${f.ref}` : ''}`;
}

export function learningLines(l, { recurring = [], days = DEFAULT_RULES.recurrenceDays, hint = true } = {}) {
  const lines = [];
  if (l?.unchanged?.length) {
    lines.push(`- Still open, unchanged since last report (${l.unchanged.length}): ${l.unchanged.map((f) => `${f.keys?.[0] ?? f.subject ?? f.rule} (${f.rule}, since ${f.firstSeen.slice(0, 10)}, ref ${f.ref})`).join('; ')}`);
  }
  if (l?.suppressed?.length) lines.push(`- Hidden because you dismissed them and nothing changed (${l.suppressed.length}): ${l.suppressed.map((f) => `ref ${f.ref}`).join(', ')}`);
  if (l?.disabled?.length) lines.push(`- Switched off in the rules file: ${[...new Set(l.disabled.map((f) => f.rule))].join(', ')}`);
  if (l?.penalised?.length) lines.push(`- Ranked lower because you usually dismiss them: ${l.penalised.join(', ')}`);
  if (recurring.length) {
    lines.push(`- 🔁 Recurring blockers (last ${days} days): ${recurring.slice(0, 10).map((r) => `${r.key} (${r.episodes > 1 ? `blocked ${r.episodes} times` : `blocked ${r.blockedDays} days`}${r.current ? ', blocked now' : ''})`).join('; ')}`);
  }
  if (lines.length) lines.unshift('', '**🧠 From past reports and your feedback**');
  if (hint) lines.push('', 'Give feedback on a follow-up by its ref: npm run risk -- <ref> valid, dismissed or resolved "note"');
  return lines;
}
