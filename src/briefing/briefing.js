// Morning briefing, midday update and end-of-day summary, delivered to your
// personal Teams chat. Claude writes them from compact context; without
// Claude (off, over the daily limit, or failing) a rule-based version is sent.
// Each briefing is claimed once per day before sending, so neither restarts
// nor a second running instance can send a duplicate.

import { logger } from '../logger.js';
import { contentHash } from '../store.js';
import { dayKey } from '../time.js';
import { runPriorityEngine } from '../priority/engine.js';
import { buildBriefingContext, buildMorningContext, hasChanges } from './context.js';

const log = logger.child({ component: 'briefing' });

export const KINDS = ['morning', 'midday', 'eod'];
const TITLES = { morning: '☀️ Morning briefing', midday: '🕛 Midday update', eod: '🌙 End-of-day summary' };

const SYSTEM = `You write short work briefings for a senior program manager, read on a phone in a Teams chat.
Lead with what needs action. Name tickets, releases and people, give the reason in a few words, and end each item with the next step.
Use only the data provided. When a section's data is unavailable or empty, write one line saying so (for example "Not available: Outlook calendar not connected") — never fill gaps with assumptions.
Format: short bold section headings and "- " bullets, no tables, no greeting or sign-off. Link items as [label](L3) using the link ids given in the data.`;

const INSTRUCTIONS = {
  morning: `Write today's morning briefing with exactly these sections, in order:
**1. Today's priorities** — the top three actions (use "priorities"), each with why and the next step.
**2. Meetings** — time, title, purpose, key attendees, what to prepare (use "meetings"; say what's missing).
**3. Pending on you** — emails, Teams messages, Jira items, decisions, approvals (use "pending"; list sources that aren't connected).
**4. Production issues** — open critical bugs/blockers, owner, required action.
**5. Releases** — upcoming releases: date, risk, blockers, scope changes since the last briefing.
**6. ezCater** — status from "scopes.ezCater": counts by status, blocked items, unassigned, overdue, risks.
**7. Overdue** — commitments and follow-ups past due.
**8. Recommended focus** — one or two sentences: what to do first and why.
Skip items that are unchanged since yesterday unless still critical; mention how many unchanged follow-ups were omitted. Aim for under 350 words.`,
  midday: `Write a midday update covering only what changed since the morning: new urgent items, items resolved, and whether the top priorities still hold. Under 120 words.`,
  eod: `Write an end-of-day summary: what got closed today, what is still open that matters tomorrow (with the next step), and anything due tomorrow. Under 180 words.`,
};

const line = (i) => `- ${i.link ? `[${i.title}](${i.link})` : i.title} — ${i.next}`;
const missing = (reason) => `- Not available: ${reason}`;

// Rule-based text, used when Claude is off or unavailable.
export function rulesBriefing(ctx) {
  const out = [];
  if (ctx.kind === 'morning') {
    out.push('**1. Today\'s priorities**', ...(ctx.priorities.length ? ctx.priorities.map(line) : ['- Nothing open.']));
    out.push('', '**2. Meetings**', ...(ctx.meetings.available
      ? (ctx.meetings.items.length ? ctx.meetings.items.map((m) => `- ${m.time} ${m.link ? `[${m.subject}](${m.link})` : m.subject}${m.prepare.length ? ` — ${m.prepare.join('; ')}` : ''}`) : ['- No meetings today.'])
      : [missing(ctx.meetings.reason)]));
    out.push('', '**3. Pending on you**', ...(ctx.pending.items.length ? ctx.pending.items.map(line) : ['- Nothing waiting on you in connected sources.']), ...ctx.pending.missing.map(missing));
    out.push('', '**4. Production issues**', ...(ctx.production.length ? ctx.production.map((p) => `${line(p)} (owner: ${p.owner})`) : ['- No open production blockers in tracked projects.']));
    out.push('', '**5. Releases**', ...(ctx.releases.length
      ? ctx.releases.map((r) => `- ${r.link ? `[${r.release}](${r.link})` : r.release} (${r.date}, ${r.risk}): ${r.reasons[0] ?? `${r.openIssues} open`}${Array.isArray(r.scopeChange?.added) && r.scopeChange.added.length ? `; added ${r.scopeChange.added.join(', ')}` : ''}`)
      : ['- No upcoming releases in the release window.']));
    const ez = ctx.scopes.ezCater;
    out.push('', '**6. ezCater**', ...(!ez ? [missing('no ezCater scope configured (PMO_SCOPES)')] : !ez.available ? [missing(ez.reason)]
      : [`- ${ez.total} open: ${Object.entries(ez.byStatus).slice(0, 4).map(([s, n]) => `${n} ${s}`).join(', ')}`,
        `- Blocked: ${ez.blocked.length}, unassigned: ${ez.unassigned}, overdue: ${ez.overdue.length}`,
        ...ez.blocked.slice(0, 3).map((b) => `- ${b.link ? `[${b.key}](${b.link})` : b.key} blocked${b.blockedBy.length ? ` by ${b.blockedBy.join(', ')}` : ''} (${b.owner})`)]));
    out.push('', '**7. Overdue**', ...(ctx.overdue.length ? ctx.overdue.map(line) : ['- Nothing new overdue.']));
    if (ctx.unchangedFollowUpsOmitted) out.push(`- ${ctx.unchangedFollowUpsOmitted} unchanged follow-up(s) omitted`);
    const first = ctx.priorities[0];
    out.push('', '**8. Recommended focus**', first ? `Start with ${first.title}: ${first.why[0] ?? ''}. Next: ${first.next}` : 'No urgent items.');
  } else if (ctx.kind === 'midday') {
    const c = ctx.changesSinceMorning;
    if (!hasChanges(c)) out.push('No changes since the morning briefing.');
    if (c.new.length) out.push('**New**', ...c.new.map((x) => `- ${x.title}`));
    if (c.closed.length) out.push('**Resolved**', ...c.closed.map((x) => `- ${x.title} (${x.how})`));
    out.push('', '**Top priorities now**', ...ctx.topItems.slice(0, 3).map(line));
  } else {
    const c = ctx.changesToday;
    out.push(`**Closed today** (${c.closed.length})`, ...(c.closed.length ? c.closed.map((x) => `- ${x.title} (${x.how})`) : ['- Nothing closed today.']));
    if (ctx.stillOpen.length) out.push('', '**Still open for tomorrow**', ...ctx.stillOpen.slice(0, 5).map(line));
    if (ctx.dueTomorrow.length) out.push('', '**Due tomorrow**', ...ctx.dueTomorrow.map(line));
  }
  return out.join('\n');
}

// live: { jiraClient, graph, scopes, calendarEnabled, jiraEnabled, outlookEnabled, teamsEnabled }
export function createBriefingService({ store, claude, notifier, timeZone = 'America/New_York', live = {} }) {
  async function compose(kind, now) {
    const report = await runPriorityEngine(store, { now });
    let ctx;
    let links = null;
    let snapshot = null;
    if (kind === 'morning') {
      ({ context: ctx, links, snapshot } = await buildMorningContext(store, report, { now, timeZone, live }));
    } else {
      ctx = buildBriefingContext(store, report, kind, { now, timeZone });
    }
    const inputHash = contentHash(ctx);
    const expand = (t) => (links ? links.expand(t) : t);

    // Incremental: nothing changed since the morning → no Claude call.
    if (kind === 'midday' && !hasChanges(ctx.changesSinceMorning)) {
      return { method: 'unchanged', content: rulesBriefing(ctx), inputHash, ctx, snapshot };
    }
    if (claude.enabled) {
      try {
        const { text } = await claude.complete({
          purpose: `briefing_${kind}`,
          system: SYSTEM,
          user: `${INSTRUCTIONS[kind]}\n\nData:\n${JSON.stringify(ctx)}`,
          effort: kind === 'morning' ? 'medium' : 'low',
        });
        return { method: 'claude', content: expand(text), inputHash, ctx, snapshot };
      } catch (err) {
        log.warn('briefing falls back to rules', { kind, error: err.message });
        return { method: 'rules-fallback', content: expand(rulesBriefing(ctx)), inputHash, ctx, snapshot };
      }
    }
    return { method: 'rules', content: expand(rulesBriefing(ctx)), inputHash, ctx, snapshot };
  }

  return {
    // Generates (once per day per kind) and delivers a briefing. A briefing
    // that failed to send is re-sent as-is, without regenerating it.
    async run(kind, { now = new Date(), force = false } = {}) {
      if (!KINDS.includes(kind)) throw new Error(`Unknown briefing "${kind}"`);
      const day = dayKey(now, timeZone);
      let briefing = store.getBriefing(kind, day);
      if (briefing?.sent_at && !force) return { kind, day, skipped: 'already sent', briefing };

      // Atomic claim: only one run per kind and day can proceed.
      const claimKey = `${kind}:${day}${force ? `:force:${now.getTime()}` : ''}`;
      if (!store.claimEvent('briefing', claimKey)) return { kind, day, skipped: 'already being sent' };

      try {
        let counts = null;
        if (!briefing || force) {
          const composed = await compose(kind, now);
          counts = composed.ctx.counts;
          if (force && briefing?.sent_at) {
            briefing = { ...briefing, method: composed.method, content: composed.content, id: null };
          } else {
            briefing = store.saveBriefing({ kind, day, method: composed.method, inputHash: composed.inputHash, content: composed.content, snapshot: composed.snapshot });
          }
        }

        const title = `${TITLES[kind]} — ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone })}`;
        const result = await notifier.send({
          title,
          body: briefing.content,
          facts: counts ? [['Critical', counts.critical], ['Waiting on you', counts.waitingOnMe], ['Follow-ups', counts.followUps]] : [],
        });
        if (result.dryRun) {
          if (briefing.id) {
            store.markBriefingSent(briefing.id);
            store.markBriefingFailed(briefing.id, 'dry run: TEAMS_WEBHOOK_URL not set');
          }
          return { kind, day, method: briefing.method, content: briefing.content, sent: false, dryRun: true };
        }
        if (briefing.id) store.markBriefingSent(briefing.id);
        log.info('briefing delivered', { kind, day, method: briefing.method });
        return { kind, day, method: briefing.method, content: briefing.content, sent: true };
      } catch (err) {
        store.releaseEvent('briefing', claimKey); // allow a retry
        if (briefing?.id) store.markBriefingFailed(briefing.id, err.message);
        log.error('briefing failed', { kind, day, error: err.message });
        return { kind, day, method: briefing?.method, content: briefing?.content, sent: false, error: err.message };
      }
    },
  };
}
