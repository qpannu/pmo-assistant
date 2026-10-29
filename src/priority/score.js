// Deterministic scoring for action items. Every point awarded comes with a
// human-readable reason, so each ranking can be explained without Claude.

import { truncate } from '../text.js';

export const CATEGORIES = Object.freeze({
  CRITICAL: 'critical',
  WAITING: 'waiting_on_me',
  RELEASES: 'release_risks',
  FOLLOW_UPS: 'follow_ups',
});

export const CRITICAL_SCORE = 70;
const STALE_OVERDUE_DAYS = 60;
const BUSINESS_WORDS = /\b(merchants?|customers?|revenue|payments?|outage|go[- ]live|launch|contract|sla|escalat\w*)\b/i;
const SYSTEM_NAMES = { jira: 'Jira', outlook: 'Outlook', teams: 'Teams' };

const dayMs = 86_400_000;
const daysBetween = (fromIso, now) => Math.floor((now - Date.parse(fromIso)) / dayMs);
const daysUntilDate = (ymd, now) => {
  const due = Date.parse(`${ymd.slice(0, 10)}T23:59:59`);
  return Math.ceil((due - now) / dayMs) - 1;
};
const fmtDate = (iso) => (iso ? iso.slice(0, 10) : 'unknown date');

// Builds { score, reasons[], flags } from the action and its source items.
// `ctx.releases` maps Jira version id → stored release data (with risk).
export function scoreAction(action, sources, ctx, now = new Date()) {
  const reasons = [];
  const seen = new Set();
  const add = (key, points, label) => {
    if (seen.has(key) || points === 0) return;
    seen.add(key);
    reasons.push({ points, label });
  };
  const flags = { productionBlocker: false, releaseCritical: false, releaseRelated: false, blocked: false, urgent: false };

  add('base', { 1: 30, 2: 20, 3: 10, 4: 0 }[action.priority] ?? 0, `Base priority P${action.priority}`);

  for (const s of sources) {
    const d = s.data ?? {};
    const signals = new Set(d.signals ?? []);

    if (s.source === 'jira' && s.kind === 'issue') {
      if (signals.has('production_blocker')) {
        flags.productionBlocker = true;
        add('prod', 40, `Production blocker: ${d.key} is a ${d.priority} ${d.type} (${d.status})`);
      }
      if (signals.has('blocked')) {
        flags.blocked = true;
        const by = (d.blockedBy ?? []).filter((b) => !b.done).map((b) => b.key);
        add('blocked', 12, by.length ? `${d.key} is blocked by ${by.join(', ')}` : `${d.key} is in status "${d.status}"`);
      }
      if (d.priority === 'Highest') add('jprio', 10, `Jira priority Highest`);
      else if (d.priority === 'High') add('jprio', 6, `Jira priority High`);
      for (const fv of d.fixVersions ?? []) {
        const rel = ctx.releases?.get(fv.id);
        if (!rel) continue;
        flags.releaseRelated = true;
        if (rel.risk === 'critical') add(`rel:${fv.id}`, 25, `In release ${fv.name}, which is at critical risk`);
        else if (rel.risk === 'warning') add(`rel:${fv.id}`, 12, `In release ${fv.name}, which needs attention`);
      }
    }

    if (s.source === 'jira' && s.kind === 'release') {
      flags.releaseRelated = true;
      if (d.risk === 'critical') {
        flags.releaseCritical = true;
        add('release', 45, `Release ${s.title} is at critical risk`);
      } else if (d.risk === 'warning') {
        add('release', 25, `Release ${s.title} needs attention`);
      }
      if (d.blockedIssues?.length || d.productionBlockers?.length) {
        flags.blocked = true;
        add('reldeps', 10, `Release depends on ${[...(d.blockedIssues ?? []), ...(d.productionBlockers ?? [])].length} unresolved blocker(s)`);
      }
    }

    if (s.source === 'outlook' || s.source === 'teams') {
      const text = s.source === 'outlook' ? `${d.subject ?? ''} ${d.preview ?? ''}` : d.text ?? '';
      if (signals.has('urgent')) {
        flags.urgent = true;
        add('urgent', 25, `Urgent wording or high importance in ${SYSTEM_NAMES[s.source]}`);
      }
      if (signals.has('release_related')) {
        flags.releaseRelated = true;
        add('relmsg', 10, `Discusses a release or deployment`);
      }
      if (signals.has('urgent_discussion')) add('urgdisc', 10, `Urgent project discussion`);
      if (signals.has('mentioned_me')) add('mention', 3, `You were @mentioned`);
      if (signals.has('my_commitment')) add('commit', 10, `You committed to this`);
      if (signals.has('awaiting_their_reply')) {
        const days = Math.max(0, daysBetween(s.occurred_at, now));
        add('noreply', 5 + Math.min(days, 10), `No reply to your question for ${days} day(s)`);
      }
      if (BUSINESS_WORDS.test(text)) add('biz', 8, `Business impact: mentions ${text.match(BUSINESS_WORDS)[0].toLowerCase()}`);
    }
  }

  // Waiting on me: the longer it waits, the higher it climbs (capped).
  if (action.type === 'decide' || action.type === 'respond') {
    const oldest = sources.map((s) => s.occurred_at).filter(Boolean).sort()[0] ?? action.created_at;
    const waited = Math.max(0, daysBetween(oldest, now));
    add('waiting', (action.type === 'decide' ? 18 : 15) + Math.min(waited, 10),
      `${action.type === 'decide' ? 'Decision' : 'Response'} waiting on you${waited ? ` for ${waited} day(s)` : ' since today'}`);
  }

  if (action.due_at) {
    const days = daysUntilDate(action.due_at, now);
    // Long-overdue items are usually abandoned, not urgent: surface them for cleanup instead.
    if (days < -STALE_OVERDUE_DAYS) add('due', 5, `Overdue since ${fmtDate(action.due_at)} (${-days} days) — probably stale; close or re-plan`);
    else if (days < 0) add('due', 20 + Math.min(-days * 2, 20), `Overdue by ${-days} day(s) (due ${fmtDate(action.due_at)})`);
    else if (days <= 2) add('due', 10, `Due ${days === 0 ? 'today' : `in ${days} day(s)`} (${fmtDate(action.due_at)})`);
  }

  const systems = new Set(sources.map((s) => s.source));
  if (systems.size > 1) add('multi', 8, `Raised in ${[...systems].map((x) => SYSTEM_NAMES[x]).join(' and ')}`);

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, reasons: reasons.sort((a, b) => b.points - a.points), flags };
}

export function categorize(action, { score, flags }) {
  if (score >= CRITICAL_SCORE || flags.productionBlocker || flags.releaseCritical) return CATEGORIES.CRITICAL;
  if (action.type === 'decide' || action.type === 'respond') return CATEGORIES.WAITING;
  if (flags.releaseRelated) return CATEGORIES.RELEASES;
  return CATEGORIES.FOLLOW_UPS;
}

// One line of evidence per source, quoting what triggered the action.
export function evidenceFor(sources) {
  return sources.map((s) => {
    const d = s.data ?? {};
    let text;
    if (s.source === 'jira' && s.kind === 'release') {
      text = `Release ${s.title}, due ${fmtDate(d.releaseDate)}: ${(d.reasons ?? []).join('; ') || 'no open risks'}`;
    } else if (s.source === 'jira') {
      const last = d.recentComments?.at(-1);
      text = `${d.key} · ${d.status} · ${d.priority ?? 'no priority'} · ${d.assignee?.name ?? 'unassigned'}`
        + (d.dueDate ? ` · due ${d.dueDate}` : '')
        + ((d.signals ?? []).includes('awaiting_my_reply') && last ? ` · ${last.author?.name}: "${truncate(last.text, 140)}"` : '');
    } else if (s.source === 'outlook') {
      text = `${d.folder === 'sentitems' ? 'You wrote' : `Email from ${d.from?.name ?? d.from?.address}`} on ${fmtDate(d.receivedAt ?? d.sentAt)}: "${d.subject}" — ${truncate(d.preview ?? '', 160)}`;
    } else {
      text = `Teams${d.chatTopic ? ` (${d.chatTopic})` : ''}, ${d.from?.name ?? 'someone'} on ${fmtDate(d.createdAt)}: "${truncate(d.text ?? '', 160)}"`;
    }
    return { system: SYSTEM_NAMES[s.source] ?? s.source, title: s.title, url: s.url, text };
  });
}

// Concrete, deterministic next step for the item.
export function nextActionFor(action, sources, flags) {
  const jira = sources.find((s) => s.source === 'jira' && s.kind === 'issue')?.data;
  const release = sources.find((s) => s.source === 'jira' && s.kind === 'release');
  const msg = sources.find((s) => s.source === 'outlook' || s.source === 'teams');
  const who = msg?.data?.from?.name ?? 'the sender';
  const where = msg ? (msg.source === 'outlook' ? 'by email' : `in Teams${msg.data.chatTopic ? ` (${msg.data.chatTopic})` : ''}`) : '';

  if (release) {
    const blockers = [...(release.data.blockedIssues ?? []), ...(release.data.productionBlockers ?? [])];
    if (release.data.daysLeft !== null && release.data.daysLeft < 0) {
      return release.data.openIssues
        ? `Run a go/no-go for ${release.title}: finish or descope its ${release.data.openIssues} open issue(s), then set a new release date in Jira.`
        : `Confirm ${release.title} shipped and mark it released in Jira, or set a new date.`;
    }
    return blockers.length
      ? `Unblock ${blockers.slice(0, 3).join(', ')} or descope them from ${release.title}.`
      : `Review the open issues in ${release.title} with the team and agree what ships.`;
  }
  if (flags.productionBlocker && jira) {
    return `Get an owner and fix ETA for ${jira.key} from ${jira.assignee?.name ?? 'the team'} today; escalate if there is no ETA.`;
  }
  const s = new Set(sources.flatMap((x) => x.data?.signals ?? []));
  switch (action.type) {
    case 'decide':
      return s.has('approval_requested')
        ? `Approve or reject, and reply to ${who} ${where} with the decision.`
        : `Make the call and reply to ${who} ${where} with your decision and reasoning.`;
    case 'respond':
      if (jira) return `Reply on ${jira.key} to ${jira.recentComments?.at(-1)?.author?.name ?? 'the commenter'} in Jira.`;
      return `Reply to ${who} ${where}.`;
    case 'prioritize':
      return `Decide the priority and owner, and communicate it to the team.`;
    case 'review':
      return `Read the thread and decide whether you need to step in.`;
    default:
      if (s.has('my_commitment')) return `Deliver what you promised${action.due_at ? ` (due ${fmtDate(action.due_at)})` : ''}, or send an updated ETA.`;
      if (s.has('awaiting_their_reply')) return `Nudge ${msg?.data?.to?.[0] ?? 'the recipient'} for a reply, or escalate.`;
      if (jira && s.has('overdue')) return `Update ${jira.key}: close it, re-plan the due date, or escalate.`;
      if (jira && s.has('blocked')) return `Chase the owners of ${(jira.blockedBy ?? []).filter((b) => !b.done).map((b) => b.key).join(', ') || 'the blocker'}.`;
      return `Follow up and update the status.`;
  }
}
