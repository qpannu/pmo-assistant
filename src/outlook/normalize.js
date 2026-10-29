// Graph message → compact stored record. Read state is deliberately left out:
// opening an email must not make it look "changed", and unread ≠ actionable.

import { extractJiraKeys, truncate } from '../text.js';

export const MAIL_SELECT = [
  'id', 'conversationId', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime',
  'sentDateTime', 'importance', 'flag', 'inferenceClassification', 'bodyPreview', 'webLink', 'isDraft',
].join(',');

const MAX_RECIPIENTS = 25;
const addr = (r) => r?.emailAddress?.address?.toLowerCase() ?? null;

export function normalizeMessage(m, folder) {
  const to = (m.toRecipients ?? []).map(addr).filter(Boolean);
  const cc = (m.ccRecipients ?? []).map(addr).filter(Boolean);
  const subject = m.subject ?? '';
  const preview = truncate((m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(), 500);
  return {
    id: m.id,
    conversationId: m.conversationId ?? m.id,
    folder,
    subject,
    from: m.from ? { name: m.from.emailAddress?.name ?? null, address: addr(m.from) } : null,
    to: to.slice(0, MAX_RECIPIENTS),
    cc: cc.slice(0, MAX_RECIPIENTS),
    toCount: to.length,
    ccCount: cc.length,
    receivedAt: m.receivedDateTime ?? null,
    sentAt: m.sentDateTime ?? null,
    importance: m.importance ?? 'normal',
    flagStatus: m.flag?.flagStatus ?? 'notFlagged',
    flagDue: m.flag?.dueDateTime?.dateTime?.slice(0, 10) ?? null,
    focused: m.inferenceClassification !== 'other',
    isMeetingMessage: m['@odata.type'] === '#microsoft.graph.eventMessage',
    isDraft: Boolean(m.isDraft),
    preview,
    webLink: m.webLink ?? null,
    jiraKeys: extractJiraKeys(`${subject} ${preview}`),
  };
}
