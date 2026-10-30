// Turns a message you send the assistant in Teams into a reply.
// Commands (approve/reject/list drafts, help) are handled by code; questions
// get one Claude call with a compact, freshly-synced context plus the recent
// conversation, so follow-up questions keep their context. Drafts are only
// ever returned for review — nothing is sent on your behalf.

import { logger } from '../logger.js';
import { truncate } from '../text.js';
import { runPriorityEngine } from '../priority/engine.js';
import { relevantRecords } from '../assistant/ask.js';
import { draftForAction, sendLinks } from '../assistant/drafts.js';
import { allItems, compactItem, createLinkTable } from '../briefing/context.js';
import { scopeSnapshot, scopesIn } from '../jira/scope.js';

const log = logger.child({ component: 'chat' });
const FRESH_MINUTES = 10;

export const HELP = `I can answer questions about your priorities, releases, ezCater and pending items, and draft replies for you to review.
Try:
- What should I focus on today?
- What is blocking the next POS release?
- What decisions are waiting for me?
- Summarize the latest ezCater progress.
- What changed since yesterday?
- Draft a response to my manager about the release date
- Draft a reply to #12 (an action item id)
- drafts · approve draft 7 · reject draft 7
I never send anything for you: drafts come back here for review.`;

const SYSTEM = `You are a PMO assistant chatting with a senior program manager in Microsoft Teams; they read on a phone.
Answer from the data provided only: lead with the answer, then the key facts (ticket keys, people, dates) as short bullets. Link items as [label](L3) using the link ids given.
If the data doesn't contain the answer, say exactly what is missing and where it would come from. Use the conversation history to resolve follow-ups like "and the other one?".
Keep answers under 150 words unless a list is asked for. No greeting or sign-off.`;

const DRAFT_SYSTEM = `You draft messages that a senior program manager will review, edit and send themselves.
Write in a natural, friendly-professional first-person voice. Email: short subject, 2–5 short paragraphs, brief greeting by first name, one-line sign-off without a name. Teams: 1–3 short sentences, no greeting line or sign-off.
Use only facts from the provided context and instruction. Don't commit to dates, approvals or decisions the instruction doesn't state; put a [placeholder] where a fact is needed.`;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

const since24h = (now) => new Date(now - 86_400_000).toISOString();

function draftReply(draft, method) {
  const to = draft.target?.to || draft.target?.address || 'recipient not set';
  return [
    `📝 **Draft #${draft.id}** — ${draft.channel} to ${to} — **not sent**${method.startsWith('template') ? ' (template; Claude unavailable)' : ''}`,
    draft.subject ? `**Subject:** ${draft.subject}` : null,
    '',
    draft.body,
    '',
    `Reply **approve draft ${draft.id}** to get send links (you send it), or **reject draft ${draft.id}**.`,
  ].filter((x) => x !== null).join('\n');
}

export function createChatHandler({ store, claude, config, jiraClient = null, scheduler = null }) {
  // Pull a fresh incremental Jira sync if the data is older than a few minutes.
  async function ensureFresh() {
    if (!scheduler?.has('jira')) return;
    const last = store.getSyncState('jira')?.last_success_at;
    if (last && Date.now() - Date.parse(last) < FRESH_MINUTES * 60_000) return;
    try {
      await Promise.race([scheduler.runNow('jira'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45_000))]);
    } catch (err) {
      log.warn('fresh jira sync failed; answering from stored data', { error: err.message });
    }
  }

  async function handleDrafts(text, chatId) {
    const decide = text.match(/^(approve|reject)\s+draft\s+#?(\d+)/i);
    if (decide) {
      const id = Number(decide[2]);
      const ok = decide[1].toLowerCase() === 'approve' ? store.approveDraft(id) : store.rejectDraft(id);
      if (!ok) return `Draft #${id} isn't pending (already decided, or doesn't exist).`;
      if (decide[1].toLowerCase() === 'reject') return `Draft #${id} rejected. Nothing was sent.`;
      const draft = store.getDraft(id);
      const links = sendLinks(draft).map((l) => `- [${l.title}](${l.url})`);
      return [`✅ Draft #${id} approved. **Send it yourself** using a link below, then tell me "sent draft ${id}".`, ...links].join('\n');
    }
    const sent = text.match(/^sent\s+draft\s+#?(\d+)/i);
    if (sent) {
      const id = Number(sent[1]);
      return store.claimDraftForSend(id) && store.markDraftSent(id) ? `Marked draft #${id} as sent.` : `Draft #${id} must be approved first.`;
    }
    if (/^drafts?$/i.test(text)) {
      const pending = store.listDrafts('pending');
      return pending.length
        ? ['**Drafts waiting for review**', ...pending.map((d) => `- #${d.id} ${d.channel} to ${d.target?.to || d.target?.address || '?'}: ${truncate(d.subject || d.body, 60)}`)].join('\n')
        : 'No drafts waiting for review.';
    }

    // "draft …" — for an action item, or a free-form message to someone.
    const channel = /\bteams\b|\bchat\b/i.test(text) ? 'teams' : 'email';
    const actionRef = text.match(/#(\d+)\b/);
    if (actionRef) {
      const { draft, method } = await draftForAction({ store, claude, actionId: Number(actionRef[1]), channel, guidance: text, myName: config.myName });
      return draftReply(draft, method);
    }

    let to = null;
    if (/\bmy (manager|boss)\b/i.test(text)) {
      if (!config.myManager.name && !config.myManager.email) {
        return 'I don\'t know who your manager is. Set MY_MANAGER_NAME and MY_MANAGER_EMAIL in .env (then restart), or name the person: "draft an email to Randy about …".';
      }
      to = { name: config.myManager.name, address: config.myManager.email || null };
    } else {
      const named = text.match(/\bto\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
      if (named) to = { name: named[1], address: null };
    }
    if (!to) return 'Who is it for? For example: "draft an email to my manager about …", "draft a Teams reply to Randy about …", or "draft a reply to #12".';

    // Context: what this person recently sent you, and your current priorities.
    const first = to.name?.split(' ')[0]?.toLowerCase();
    const fromThem = ['outlook', 'teams'].flatMap((source) => store.listItemsSince(source, new Date(Date.now() - 14 * 86_400_000).toISOString()))
      .filter((i) => first && i.author?.toLowerCase().includes(first)).slice(-5)
      .map((i) => `${i.source} ${i.occurred_at?.slice(0, 10)}: ${truncate(i.data.subject ?? '', 80)} ${truncate(i.data.preview ?? i.data.text ?? '', 200)}`);
    const report = await runPriorityEngine(store);
    const priorities = allItems(report).slice(0, 5).map((i) => truncate(i.title, 90));

    let subject = '';
    let body;
    let method = 'template (Claude unavailable)';
    if (claude.enabled) {
      try {
        const { json } = await claude.complete({
          purpose: 'chat_draft',
          system: DRAFT_SYSTEM,
          user: JSON.stringify({ channel, to: to.name, instruction: text, theirRecentMessages: fromThem, myCurrentPriorities: priorities, from: config.myName || 'me' }),
          schema: DRAFT_SCHEMA,
        });
        ({ subject, body } = json);
        method = 'claude';
      } catch (err) {
        method = `template (Claude unavailable: ${err.message})`;
      }
    }
    body ??= `Hi ${to.name?.split(' ')[0] ?? ''},\n\n[Your message: ${text}]`;
    const id = store.createDraft({ channel, target: { to: to.name, address: to.address }, subject: channel === 'email' ? subject : null, body });
    return draftReply(store.getDraft(id), method);
  }

  async function answer(question, chatId) {
    await ensureFresh();
    const now = new Date();
    const report = await runPriorityEngine(store, { now });
    const links = createLinkTable();
    const { actions, issues } = relevantRecords(store, report, question);
    const items = allItems(report);
    const events = store.actionEventsSince(since24h(now));

    const scopes = {};
    for (const name of scopesIn(question, config.pmoScopes)) {
      try {
        const s = await scopeSnapshot(jiraClient, name, config.pmoScopes[name], { now });
        const ref = (x) => ({ ...x, url: undefined, link: links.ref(x.url) });
        scopes[name] = { ...s, blocked: s.blocked.map(ref), unassigned: s.unassigned.map(ref), highPriority: s.highPriority.map(ref), overdue: s.overdue.map(ref), changedLast24h: s.changedLast24h.map(ref) };
      } catch (err) {
        scopes[name] = { available: false, reason: jiraClient ? `Jira query failed: ${err.message}` : 'Jira not configured' };
      }
    }
    const unknownTeam = question.match(/\bteam\s+([A-Z][\w-]+)/i);
    const missingScopes = unknownTeam && !Object.keys(scopes).length
      ? [`No Jira scope is configured for "${unknownTeam[0]}". Add it to PMO_SCOPES as {"${unknownTeam[0]}": "<JQL>"}.`] : [];

    const data = {
      now: now.toISOString(),
      dataFreshness: Object.fromEntries(['jira', 'outlook', 'teams'].map((s) => [s, store.getSyncState(s)?.last_success_at ?? 'not connected'])),
      counts: report.counts,
      topPriorities: items.slice(0, 5).map((i) => compactItem(i, links)),
      waitingOnMe: report.waitingOnMe.slice(0, 8).map((i) => compactItem(i, links)),
      releases: store.listItems({ source: 'jira', kind: 'release' }).filter((r) => r.data.tracked)
        .map((r) => ({ release: r.title, date: r.data.releaseDate, risk: r.data.risk, reasons: r.data.reasons, blockers: [...(r.data.blockedIssues ?? []), ...(r.data.productionBlockers ?? [])], link: links.ref(r.url) })),
      changesLast24h: {
        new: events.filter((e) => e.event === 'created').map((e) => truncate(e.title, 90)).slice(0, 10),
        closed: events.filter((e) => /^status:(done|dismissed)$/.test(e.event)).map((e) => truncate(e.title, 90)).slice(0, 10),
      },
      relevant: actions.map((x) => compactItem(x.i, links)),
      jiraIssues: issues.map((x) => ({ ...x, url: undefined, link: links.ref(x.url) })),
      scopes,
      missing: missingScopes,
    };

    if (!claude.enabled) return rulesAnswer(question, data, links);
    const history = store.recentChatTurns(chatId).map((t) => `${t.role === 'user' ? 'Me' : 'Assistant'}: ${truncate(t.text, 400)}`);
    try {
      const { text } = await claude.complete({
        purpose: 'chat',
        system: SYSTEM,
        user: `${history.length ? `Conversation so far:\n${history.join('\n')}\n\n` : ''}Question: ${question}\n\nData:\n${JSON.stringify(data)}`,
      });
      return links.expand(text);
    } catch (err) {
      log.warn('chat answer falls back to rules', { error: err.message });
      return `${rulesAnswer(question, data, links)}\n\n_(Claude unavailable: ${truncate(err.message, 80)})_`;
    }
  }

  return {
    async handle(rawText, { chatId }) {
      const text = String(rawText ?? '').trim();
      if (!text) return null;
      if (/^(help|\?|hi|hello)$/i.test(text)) return HELP;
      if (/^(approve|reject|sent)\s+draft\b|^drafts?$|^draft\b/i.test(text)) return handleDrafts(text, chatId);
      return answer(text, chatId);
    },
  };
}

// Answers common questions without Claude (Claude off, over limit, or failing).
export function rulesAnswer(question, data, links) {
  const q = question.toLowerCase();
  const line = (i) => `- ${i.link ? `[${i.title}](${i.link})` : i.title} — ${i.next}`;
  const out = [];
  if (/focus|priorit|first|today/.test(q)) out.push('**Top priorities**', ...data.topPriorities.slice(0, 3).map(line));
  if (/decision|waiting|pending|owe|approv/.test(q)) out.push('**Waiting on you**', ...(data.waitingOnMe.length ? data.waitingOnMe.map(line) : ['- Nothing in connected sources.']));
  if (/block|release|pos/.test(q)) {
    out.push('**Releases**', ...(data.releases.length ? data.releases.map((r) => `- ${r.link ? `[${r.release}](${r.link})` : r.release} (${r.date}, ${r.risk}): ${r.reasons[0] ?? 'no open risks'}${r.blockers.length ? `; blockers ${r.blockers.join(', ')}` : ''}`) : ['- No releases in the window.']));
  }
  if (/change|since|yesterday|new/.test(q)) {
    out.push('**Last 24 hours**', `- New: ${data.changesLast24h.new.length ? data.changesLast24h.new.join('; ') : 'none'}`, `- Closed: ${data.changesLast24h.closed.length ? data.changesLast24h.closed.join('; ') : 'none'}`);
  }
  for (const [name, s] of Object.entries(data.scopes)) {
    if (s.available === false) out.push(`**${name}**`, `- Not available: ${s.reason}`);
    else out.push(`**${name}** — ${s.total} open`, `- ${Object.entries(s.byStatus).slice(0, 5).map(([k, v]) => `${v} ${k}`).join(', ')}`, `- Blocked ${s.blocked.length}, unassigned ${s.unassigned.length}, overdue ${s.overdue.length}`);
  }
  out.push(...data.missing.map((m) => `- ${m}`));
  if (!out.length) {
    out.push(data.relevant.length || data.jiraIssues.length ? '**Most relevant records**' : 'I couldn\'t find records matching that. Try a Jira key, a release name, or "help".',
      ...data.relevant.map(line), ...data.jiraIssues.map((i) => `- ${i.link ? `[${i.key}](${i.link})` : i.key} ${i.summary} — ${i.status}, ${i.assignee ?? 'unassigned'}`));
  }
  return links.expand(out.join('\n'));
}
