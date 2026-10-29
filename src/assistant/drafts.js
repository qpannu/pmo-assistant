// Drafts replies for an action item. Drafts are only ever stored for review:
// this assistant has no code that sends email or Teams messages. After you
// approve a draft you get copy-ready text and links to send it yourself.

import { truncate } from '../text.js';
import { evidenceFor } from '../priority/score.js';

const SYSTEM = `You draft messages that a senior program manager will review, edit and send themselves.
Write in a natural, friendly-professional first-person voice, matching the channel:
- email: a short subject and 2–5 short paragraphs at most, with a brief greeting by first name and a one-line sign-off without a name;
- teams: 1–3 short sentences, conversational, no greeting line or sign-off.
Answer what was asked, using the thread and the manager's guidance. Don't commit to dates, approvals or decisions that the guidance doesn't state; put a [placeholder] where a fact is needed.`;

const SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

function recipientFor(sources, channel) {
  const msg = sources.find((s) => s.source === (channel === 'email' ? 'outlook' : 'teams'))
    ?? sources.find((s) => s.source === 'outlook' || s.source === 'teams');
  if (!msg) return { name: null, address: null, chatId: null, replyUrl: sources[0]?.url ?? null, subject: sources[0]?.title ?? '' };
  const d = msg.data;
  const sent = d.folder === 'sentitems';
  return {
    name: sent ? null : d.from?.name ?? null,
    address: msg.source === 'outlook' ? (sent ? d.to?.[0] : d.from?.address) ?? null : null,
    chatId: d.chatId ?? null,
    replyUrl: msg.url,
    subject: d.subject ?? '',
  };
}

export function sendLinks(draft) {
  const t = draft.target ?? {};
  const links = [];
  if (t.replyUrl) links.push({ title: 'Open the original message', url: t.replyUrl });
  if (draft.channel === 'email') {
    const qs = new URLSearchParams({ ...(t.address && { to: t.address }), subject: draft.subject ?? '', body: draft.body });
    links.push({ title: 'Compose in Outlook (you send it)', url: `https://outlook.office.com/mail/deeplink/compose?${qs.toString().replace(/\+/g, '%20')}` });
  } else if (t.address) {
    links.push({ title: 'Open Teams chat with text (you send it)', url: `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(t.address)}&message=${encodeURIComponent(draft.body)}` });
  }
  return links;
}

export async function draftForAction({ store, claude, actionId, channel = 'email', guidance = '', myName = '' }) {
  if (!['email', 'teams'].includes(channel)) throw Object.assign(new Error('channel must be "email" or "teams"'), { status: 400 });
  const action = store.getActionItem(actionId);
  if (!action) throw Object.assign(new Error('Action item not found'), { status: 404 });

  const sources = store.listActionSourceItems(actionId);
  const to = recipientFor(sources, channel);
  const thread = evidenceFor(sources).map((e) => `${e.system}: ${truncate(e.text, 400)}`);

  let subject = to.subject ? (/^re:/i.test(to.subject) ? to.subject : `Re: ${to.subject}`) : action.title;
  let body;
  let method = 'template';
  if (claude.enabled) {
    try {
      const { json } = await claude.complete({
        purpose: 'draft',
        system: SYSTEM,
        user: JSON.stringify({ channel, from: myName || 'me', to: to.name, about: action.title, thread, suggestedNextStep: action.title, guidance }),
        schema: SCHEMA,
      });
      subject = json.subject || subject;
      body = json.body;
      method = 'claude';
    } catch (err) {
      method = `template (Claude unavailable: ${err.message})`;
    }
  }
  body ??= `${to.name ? `Hi ${to.name.split(' ')[0]},\n\n` : ''}[Your reply about: ${action.title}]${guidance ? `\n\nNotes: ${guidance}` : ''}`;

  const id = store.createDraft({
    actionItemId: actionId,
    channel,
    target: { to: to.name, address: to.address, chatId: to.chatId, replyUrl: to.replyUrl },
    subject: channel === 'email' ? subject : null,
    body,
  });
  const draft = store.getDraft(id);
  return { draft, method, note: 'Draft saved for your review. Nothing has been sent.' };
}
