// Rule-based signals — cheap, deterministic and free of Claude tokens. Claude
// later works only on items these rules mark as relevant and changed.

import { detectIntents } from '../text.js';

export const SIGNALS = Object.freeze({
  ASSIGNED_TO_ME: 'assigned_to_me',
  OVERDUE: 'overdue',
  DUE_SOON: 'due_soon',
  AWAITING_DECISION: 'awaiting_my_decision',
  AWAITING_REPLY: 'awaiting_my_reply',
  PRODUCTION_BLOCKER: 'production_blocker',
  BLOCKED: 'blocked',
});

const DUE_SOON_DAYS = 3;

const lowerSet = (values) => new Set(values.map((v) => v.toLowerCase()));
const has = (set, value) => Boolean(value) && set.has(value.toLowerCase());

// Whole days from `today` (YYYY-MM-DD) to `date` (YYYY-MM-DD or ISO).
export function daysUntil(date, today) {
  const d = Date.parse(date.slice(0, 10) + 'T00:00:00Z');
  const t = Date.parse(today + 'T00:00:00Z');
  return Math.round((d - t) / 86_400_000);
}

export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function compileRules(jira) {
  return {
    prodTypes: lowerSet(jira.prodIssueTypes),
    blockerPriorities: lowerSet(jira.blockerPriorities),
    prodLabels: lowerSet(jira.prodLabels),
    decisionLabels: lowerSet(jira.decisionLabels),
    decisionStatuses: lowerSet(jira.decisionStatuses),
    blockedStatuses: lowerSet(jira.blockedStatuses),
    prodActiveDays: jira.prodActiveDays,
    replyWindowDays: jira.replyWindowDays,
  };
}

const ageDays = (iso, now) => (now - Date.parse(iso)) / 86_400_000;

export const isOpen = (issue) => issue.statusCategory !== 'done';

export function isProductionBlocker(issue, rules) {
  return isOpen(issue)
    && has(rules.prodTypes, issue.type)
    && has(rules.blockerPriorities, issue.priority)
    && (rules.prodLabels.size === 0 || issue.labels.some((l) => has(rules.prodLabels, l)));
}

export function isBlocked(issue, rules) {
  return isOpen(issue) && (has(rules.blockedStatuses, issue.status) || issue.blockedBy.some((b) => !b.done));
}

// `updatedAt` is Jira's last-updated time, kept outside the hashed issue data.
export function issueSignals(issue, myAccountId, rules, { now, updatedAt }) {
  if (!isOpen(issue)) return [];
  const today = localToday(now);
  const out = new Set();
  const mine = issue.assignee?.accountId === myAccountId;
  const reportedByMe = issue.reporter?.accountId === myAccountId;

  if (mine) out.add(SIGNALS.ASSIGNED_TO_ME);

  if (issue.dueDate && (mine || reportedByMe)) {
    const days = daysUntil(issue.dueDate, today);
    if (days < 0) out.add(SIGNALS.OVERDUE);
    else if (days <= DUE_SOON_DAYS) out.add(SIGNALS.DUE_SOON);
  }

  if (issue.labels.some((l) => has(rules.decisionLabels, l)) || has(rules.decisionStatuses, issue.status)) {
    out.add(SIGNALS.AWAITING_DECISION);
  }

  // A mention only needs a reply if it asks something ("thanks @you" doesn't).
  const last = issue.recentComments.at(-1);
  const asks = last && (({ question, request, approval, decision }) => question || request || approval || decision)(detectIntents(last.text));
  if (last && asks && last.author?.accountId !== myAccountId && last.mentions.includes(myAccountId)
      && ageDays(last.created, now) <= rules.replyWindowDays) {
    out.add(SIGNALS.AWAITING_REPLY);
  }

  // Old backlog bugs keep their priority for years; only active ones are blockers.
  if (isProductionBlocker(issue, rules) && updatedAt && ageDays(updatedAt, now) <= rules.prodActiveDays) {
    out.add(SIGNALS.PRODUCTION_BLOCKER);
  }
  if (isBlocked(issue, rules)) out.add(SIGNALS.BLOCKED);

  return [...out].sort();
}

// Risk for one unreleased version, from the tracked issues assigned to it.
export function releaseRisk(version, issues, rules, today) {
  const open = issues.filter(isOpen);
  const blocked = open.filter((i) => isBlocked(i, rules));
  const prodBlockers = open.filter((i) => isProductionBlocker(i, rules));
  const highPriority = open.filter((i) => has(rules.blockerPriorities, i.priority));
  const daysLeft = version.releaseDate ? daysUntil(version.releaseDate, today) : null;
  const overdue = daysLeft !== null && daysLeft < 0 && !version.released;

  const reasons = [];
  if (overdue) {
    reasons.push(open.length
      ? `release date passed ${-daysLeft} day(s) ago with ${open.length} open issue(s): ${keys(open)}`
      : `release date passed ${-daysLeft} day(s) ago with no open issues — not marked released in Jira`);
  } else if (daysLeft !== null && daysLeft <= 3 && open.length) {
    reasons.push(`${open.length} open issue(s) with ${daysLeft} day(s) left`);
  }
  if (blocked.length) reasons.push(`${blocked.length} blocked issue(s): ${keys(blocked)}`);
  if (prodBlockers.length) reasons.push(`${prodBlockers.length} high-priority bug(s): ${keys(prodBlockers)}`);

  let risk = 'none';
  if ((overdue && open.length) || (daysLeft !== null && daysLeft <= 3 && (blocked.length || prodBlockers.length))) risk = 'critical';
  else if (blocked.length || prodBlockers.length || (daysLeft !== null && daysLeft <= 3 && open.length)) risk = 'warning';

  return {
    risk,
    reasons,
    daysLeft,
    openIssues: open.length,
    blockedIssues: keysArr(blocked),
    productionBlockers: keysArr(prodBlockers),
    issueKeys: keysArr(open), // open scope, to detect scope changes between briefings
    highPriorityOpen: highPriority.length,
  };
}

const keysArr = (issues) => issues.map((i) => i.key).sort();
const keys = (issues) => keysArr(issues).slice(0, 5).join(', ') + (issues.length > 5 ? ', …' : '');
