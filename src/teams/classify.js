// Which Teams messages need me: @mentions, 1:1 messages and messages naming
// me that ask, request, or need a decision — unless I already replied later in
// the same chat/thread. Urgent project or release discussions are surfaced
// even when not addressed to me.

import { ageDays, detectIntents, parseDeadline } from '../text.js';

const COMMITMENT_WINDOW_DAYS = 14;

const mentionsName = (text, firstName) => firstName.length > 1 && new RegExp(`\\b${firstName.replace(/\W/g, '')}\\b`, 'i').test(text);

// `thread` = stored messages of the same chat (or channel thread).
export function classifyChatMessage(msg, thread, me, ms, now = new Date()) {
  const none = { signals: [], dueDate: null };
  if (msg.deleted || msg.isSystem || msg.from?.isBot) return none;
  const text = `${msg.subject ?? ''}\n${msg.text}`;
  const intents = detectIntents(text);
  const age = ageDays(msg.createdAt, now);
  const signals = new Set();

  if (msg.from?.id === me.id) {
    if (intents.commitment && age <= COMMITMENT_WINDOW_DAYS) {
      return { signals: ['my_commitment'], dueDate: parseDeadline(text, new Date(msg.createdAt))?.date ?? null };
    }
    return none;
  }

  const mentioned = msg.mentionIds.includes(me.id);
  const direct = msg.chatType === 'oneOnOne';
  const directed = mentioned || direct || mentionsName(msg.text, me.firstName);
  const replied = thread.some((m) => m.from?.id === me.id && m.createdAt > msg.createdAt);
  const recent = age <= ms.replyWindowDays;

  if (mentioned) signals.add('mentioned_me');
  if (direct) signals.add('direct_message');
  if (recent && !replied) {
    if (directed) {
      if (intents.approval) signals.add('approval_requested');
      else if (intents.decision) signals.add('decision_requested');
      else if (intents.question || intents.request) signals.add('response_needed');
    } else if (intents.urgent && (intents.release || msg.jiraKeys.length)) {
      signals.add('urgent_discussion');
    }
  }

  const actionable = ['approval_requested', 'decision_requested', 'response_needed', 'urgent_discussion'].some((s) => signals.has(s));
  if (!actionable) return { signals: [...signals].sort(), dueDate: null };
  if (intents.urgent || msg.importance === 'urgent' || msg.importance === 'high') signals.add('urgent');
  if (intents.release) signals.add('release_related');
  return { signals: [...signals].sort(), dueDate: parseDeadline(text, new Date(msg.createdAt))?.date ?? null };
}
