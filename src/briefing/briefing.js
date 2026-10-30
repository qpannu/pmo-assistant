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
  // Shape requested by the user (memory/feedback_morning_briefing_format.md).
  morning: `Write today's morning briefing like a chief of staff, with these sections in order:
**📅 Calendar** — each meeting as "time — title" with whether I organize and who accepted; blocked appointments as "Blocked"; then "Free:" with the free windows and "Out today:" with people out. If the calendar isn't available, say so in one line.
**🔴 Top 3 today** — the three things that matter most. Use "priorities", and pull in production issues, releases and "scopes" (e.g. ezCater) where they belong. For each: what changed since yesterday (from "movingWithoutYou" / "changesSinceLastBriefing"), the decisions I owe, and the link to today's meetings (e.g. "prep for the 11:00 touchpoint"). Short sub-bullets are fine.
**💬 Still waiting on you** — "Person: what they need", most important first (use "pending"); name sources that aren't connected.
**✅ Moving without you** — progress others made since the last briefing, so I don't chase it (use "movingWithoutYou"). Skip the section if there's nothing.
**➡️ Suggested order** — one or two lines mapping the top items onto today's free windows.
Bullets only (no tables). Don't repeat unchanged low-priority items. Aim for under 350 words.`,
  midday: `Write a midday update covering only what changed since the morning: new urgent items, items resolved, and whether the top priorities still hold. Under 120 words.`,
  eod: `Write an end-of-day summary: what got closed today, what is still open that matters tomorrow (with the next step), and anything due tomorrow. Under 180 words.`,
};

const line = (i) => `- ${i.link ? `[${i.title}](${i.link})` : i.title} — ${i.next}`;
const missing = (reason) => `- Not available: ${reason}`;

// Rule-based text, used when Claude is off or unavailable.
export function rulesBriefing(ctx) {
  const out = [];
  if (ctx.kind === 'morning') {
    const cal = ctx.meetings;
    out.push('**📅 Calendar**', ...(cal.available
      ? [
        ...(cal.items.length ? cal.items.map((m) => (m.blockedTime
          ? `- ${m.time} — Blocked (${m.subject})`
          : `- ${m.time} — ${m.link ? `[${m.subject}](${m.link})` : m.subject}${m.youOrganize ? ' (you organize)' : ''}${m.accepted?.length ? ` — accepted: ${m.accepted.slice(0, 5).join(', ')}` : ''}${m.prepare?.length ? ` — ${m.prepare.join('; ')}` : ''}`))
          : ['- No meetings today.']),
        ...(cal.freeWindows?.length ? [`- Free: ${cal.freeWindows.join(', ')}`] : []),
        ...(cal.peopleOut?.length ? [`- Out today: ${cal.peopleOut.join(', ')}`] : []),
      ]
      : [missing(cal.reason)]));

    out.push('', '**🔴 Top 3 today**', ...(ctx.priorities.length ? ctx.priorities.map(line) : ['- Nothing open.']));
    const ez = ctx.scopes.ezCater;
    const radar = [
      ...(ctx.production.length ? [`- ${ctx.production.length} production blocker(s): ${ctx.production.slice(0, 3).map((p) => `${p.title.match(/[A-Z]+-\d+/)?.[0] ?? p.title} (${p.owner})`).join(', ')}`] : []),
      ...ctx.releases.filter((r) => r.risk !== 'none').slice(0, 3).map((r) => `- ${r.link ? `[${r.release}](${r.link})` : r.release}: ${r.reasons[0] ?? r.risk}`),
      ...(ez?.available ? [`- ezCater: ${ez.total} open, ${ez.blocked.length} blocked, ${ez.unassigned} unassigned`] : ez ? [missing(`ezCater — ${ez.reason}`)] : []),
    ];
    if (radar.length) out.push('', '**Also on your radar**', ...radar);

    out.push('', '**💬 Still waiting on you**', ...(ctx.pending.items.length ? ctx.pending.items.map(line) : ['- Nothing waiting on you in connected sources.']), ...ctx.pending.missing.map(missing));
    const overdue = ctx.overdue.filter((o) => !ctx.pending.items.some((p) => p.id === o.id));
    if (overdue.length) out.push(...overdue.slice(0, 4).map(line));
    if (ctx.unchangedFollowUpsOmitted) out.push(`- ${ctx.unchangedFollowUpsOmitted} unchanged follow-up(s) omitted`);

    out.push('', '**✅ Moving without you**', ...(typeof ctx.movingWithoutYou === 'string' ? [`- ${ctx.movingWithoutYou}`]
      : ctx.movingWithoutYou.length ? ctx.movingWithoutYou.map((m) => `- ${m.link ? `[${m.key}](${m.link})` : m.key} ${m.summary}: ${m.from} → ${m.to} (${m.owner})`)
        : ['- No status changes on others\' work since the last briefing.']));

    const first = ctx.priorities[0];
    const window = cal.available ? cal.freeWindows?.[0] : null;
    out.push('', '**➡️ Suggested order**', first ? `${window ? `In ${window}: ` : 'First: '}${first.title} — ${first.next}` : 'No urgent items.');
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
