// Which emails need me. Unread alone means nothing: an email needs a response
// only when it is addressed to me (not a broadcast), from a person (not a
// notification), recent, asks something, and I haven't replied in the thread.

import { ageDays, detectIntents, parseDeadline } from '../text.js';

const AUTOMATED_SENDER = /(no-?reply|do-?not-?reply|notification|mailer-daemon|postmaster|bounce|alerts?@|jira@|confluence@|atlassian|calendar|automated|digest|newsletter|marketing|survey)/i;
const MAX_DIRECT_RECIPIENTS = 10;
const COMMITMENT_WINDOW_DAYS = 14;
const FOLLOW_UP_MAX_DAYS = 30;

export function myIdentity(me) {
  const addresses = new Set([me.mail, me.userPrincipalName].filter(Boolean).map((a) => a.toLowerCase()));
  const name = me.displayName ?? '';
  const firstName = (name.includes(',') ? name.split(',')[1] : name).trim().split(/\s+/)[0] ?? '';
  return { id: me.id, addresses, firstName };
}

export const isAutomated = (msg) => AUTOMATED_SENDER.test(msg.from?.address ?? '') || !msg.focused || msg.isMeetingMessage;

const mentionsName = (text, firstName) => firstName.length > 1 && new RegExp(`\\b${firstName.replace(/\W/g, '')}\\b`, 'i').test(text);

// `thread` = all stored messages of the conversation (inbox and sent).
export function classifyEmail(msg, thread, me, ms, now = new Date()) {
  if (msg.removed || msg.isDraft) return { signals: [], dueDate: null };
  const text = `${msg.subject}\n${msg.preview}`;
  const intents = detectIntents(text);
  const signals = new Set();
  let dueDate = null;

  if (msg.folder === 'sentitems') {
    const later = (m) => (m.receivedAt ?? m.sentAt) > msg.sentAt;
    const age = ageDays(msg.sentAt, now);
    if (intents.commitment && age <= COMMITMENT_WINDOW_DAYS) {
      signals.add('my_commitment');
      dueDate = parseDeadline(text, new Date(msg.sentAt))?.date ?? null;
    }
    const isLatestMine = !thread.some((m) => m.folder === 'sentitems' && m.id !== msg.id && later(m));
    const answered = thread.some((m) => m.folder !== 'sentitems' && later(m));
    const toOthers = msg.to.some((a) => !me.addresses.has(a));
    if ((intents.question || intents.request) && toOthers && isLatestMine && !answered
        && age >= ms.followUpAfterDays && age <= FOLLOW_UP_MAX_DAYS) {
      signals.add('awaiting_their_reply');
    }
    return { signals: [...signals].sort(), dueDate };
  }

  if (msg.flagStatus === 'flagged') {
    signals.add('flagged');
    dueDate = msg.flagDue;
  }
  if (me.addresses.has(msg.from?.address) || isAutomated(msg)) return { signals: [...signals].sort(), dueDate };

  const toMe = msg.to.some((a) => me.addresses.has(a));
  const directed = (toMe && msg.toCount <= MAX_DIRECT_RECIPIENTS) || mentionsName(msg.preview, me.firstName);
  const replied = thread.some((m) => m.folder === 'sentitems' && m.sentAt > msg.receivedAt);
  const recent = ageDays(msg.receivedAt, now) <= ms.replyWindowDays;

  if (directed && recent && !replied) {
    // An approval/decision is the reply, so it replaces a generic "needs response".
    if (intents.approval) signals.add('approval_requested');
    else if (intents.decision) signals.add('decision_requested');
    else if (intents.question || intents.request) signals.add('response_needed');
  }

  const actionable = signals.size > 0;
  if (actionable && (intents.urgent || msg.importance === 'high')) signals.add('urgent');
  if (actionable && intents.release) signals.add('release_related');
  if (actionable && !dueDate) dueDate = parseDeadline(text, new Date(msg.receivedAt))?.date ?? null;

  return { signals: [...signals].sort(), dueDate };
}
