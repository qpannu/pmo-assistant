// Morning briefing, midday update and end-of-day summary, delivered to Teams.
// Claude writes them from compact context; without Claude (off, over the
// daily limit, or failing) a rule-based version is sent instead. A midday
// update with no changes is sent without calling Claude at all.

import { logger } from '../logger.js';
import { contentHash } from '../store.js';
import { localToday } from '../jira/classify.js';
import { runPriorityEngine } from '../priority/engine.js';
import { buildBriefingContext, hasChanges } from './context.js';

const log = logger.child({ component: 'briefing' });

export const KINDS = ['morning', 'midday', 'eod'];
const TITLES = { morning: '☀️ Morning briefing', midday: '🕛 Midday update', eod: '🌙 End-of-day summary' };

const SYSTEM = `You write short work briefings for a senior program manager, delivered as a Teams message.
Lead with what needs action. Name the tickets, releases and people involved, give the reason in a few words, and end each item with the next step. Use only the data provided; when something isn't in it, leave it out rather than guess.
Format: plain text with short bold headings and "- " bullets (Teams renders basic markdown). No greeting or sign-off.`;

const INSTRUCTIONS = {
  morning: `Write the morning briefing with these sections:
**Top 3 today** — the three items that matter most, why, and the next step.
**Cross-project risks** — up to 4 bullets on patterns across projects and releases (slipping releases, shared blockers, one team or person carrying several critical items). Use the "projects" and "releases" data.
**Waiting on you** — decisions and replies, oldest or most important first.
**New since last briefing** — only if something changed.
Keep it under 250 words.`,
  midday: `Write a midday update covering only what changed since the morning: new urgent items, items resolved, and whether the top priorities still hold. Under 120 words.`,
  eod: `Write an end-of-day summary: what got closed today, what is still open that matters tomorrow (with the next step), and anything due tomorrow. Under 180 words.`,
};

const fmtItem = (i) => `- ${i.title} — ${i.next}`;

// Rule-based text, used when Claude is off or unavailable.
export function rulesBriefing(ctx) {
  const lines = [];
  if (ctx.kind === 'morning') {
    lines.push('**Top 3 today**', ...ctx.topItems.slice(0, 3).map(fmtItem));
    if (ctx.releases.length) lines.push('', '**Releases at risk**', ...ctx.releases.map((r) => `- ${r.release} (${r.date}): ${r.reasons[0] ?? r.risk}`));
    const waiting = ctx.topItems.filter((i) => i.section === 'waiting');
    if (waiting.length) lines.push('', '**Waiting on you**', ...waiting.map(fmtItem));
    lines.push('', `${ctx.counts.critical} critical · ${ctx.counts.waitingOnMe} waiting on you · ${ctx.counts.followUps} follow-ups`);
  } else if (ctx.kind === 'midday') {
    const c = ctx.changesSinceMorning;
    if (!hasChanges(c)) lines.push('No changes since the morning briefing.');
    if (c.new.length) lines.push('**New**', ...c.new.map((x) => `- ${x.title}`));
    if (c.closed.length) lines.push('**Resolved**', ...c.closed.map((x) => `- ${x.title} (${x.how})`));
    lines.push('', '**Top priorities now**', ...ctx.topItems.slice(0, 3).map(fmtItem));
  } else {
    const c = ctx.changesToday;
    lines.push(`**Closed today** (${c.closed.length})`, ...(c.closed.length ? c.closed.map((x) => `- ${x.title} (${x.how})`) : ['- Nothing closed today.']));
    if (ctx.stillOpen.length) lines.push('', '**Still open for tomorrow**', ...ctx.stillOpen.slice(0, 5).map(fmtItem));
    if (ctx.dueTomorrow.length) lines.push('', '**Due tomorrow**', ...ctx.dueTomorrow.map(fmtItem));
  }
  return lines.join('\n');
}

export function createBriefingService({ store, claude, notifier }) {
  async function compose(kind, now) {
    const report = await runPriorityEngine(store, { now });
    const ctx = buildBriefingContext(store, report, kind, now);
    const inputHash = contentHash(ctx);
    const links = [...report.critical, ...report.waitingOnMe].slice(0, 3)
      .map((i) => i.sources[0]).filter(Boolean).map((s) => ({ title: `${s.system}: ${s.title}`, url: s.url }));

    // Incremental: nothing changed since the morning → no Claude call.
    if (kind === 'midday' && !hasChanges(ctx.changesSinceMorning)) {
      return { method: 'unchanged', content: rulesBriefing(ctx), inputHash, ctx, links };
    }
    if (claude.enabled) {
      try {
        const { text } = await claude.complete({
          purpose: `briefing_${kind}`,
          system: SYSTEM,
          user: `${INSTRUCTIONS[kind]}\n\nData:\n${JSON.stringify(ctx)}`,
          effort: kind === 'morning' ? 'medium' : 'low',
        });
        return { method: 'claude', content: text, inputHash, ctx, links };
      } catch (err) {
        log.warn('briefing falls back to rules', { kind, error: err.message });
        return { method: 'rules-fallback', content: rulesBriefing(ctx), inputHash, ctx, links };
      }
    }
    return { method: 'rules', content: rulesBriefing(ctx), inputHash, ctx, links };
  }

  return {
    // Generates (once per day per kind) and delivers a briefing. A briefing
    // that failed to send is re-sent as-is, without regenerating it.
    async run(kind, { now = new Date(), force = false } = {}) {
      if (!KINDS.includes(kind)) throw new Error(`Unknown briefing "${kind}"`);
      const day = localToday(now);
      let briefing = store.getBriefing(kind, day);
      if (briefing?.sent_at && !force) return { kind, day, skipped: 'already sent', briefing };

      let links = [];
      let counts = null;
      if (!briefing || force) {
        const composed = await compose(kind, now);
        links = composed.links;
        counts = composed.ctx.counts;
        if (force && briefing?.sent_at) {
          // Forced re-run of a sent briefing: deliver without overwriting the record.
          briefing = { ...briefing, method: composed.method, content: composed.content, id: null };
        } else {
          briefing = store.saveBriefing({ kind, day, method: composed.method, inputHash: composed.inputHash, content: composed.content });
        }
      }

      const title = `${TITLES[kind]} — ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
      try {
        const result = await notifier.send({
          title,
          body: briefing.content,
          facts: counts ? [['Critical', counts.critical], ['Waiting on you', counts.waitingOnMe], ['Follow-ups', counts.followUps]] : [],
          links,
        });
        if (result.dryRun) {
          // Recorded so the schedule doesn't retry, but marked as not delivered.
          if (briefing.id) {
            store.markBriefingSent(briefing.id);
            store.markBriefingFailed(briefing.id, 'dry run: TEAMS_WEBHOOK_URL not set');
          }
          return { kind, day, method: briefing.method, content: briefing.content, sent: false, dryRun: true };
        }
        if (briefing.id) store.markBriefingSent(briefing.id);
        log.info('briefing delivered', { kind, method: briefing.method });
        return { kind, day, method: briefing.method, content: briefing.content, sent: true };
      } catch (err) {
        if (briefing.id) store.markBriefingFailed(briefing.id, err.message);
        log.error('briefing delivery failed', { kind, error: err.message });
        return { kind, day, method: briefing.method, content: briefing.content, sent: false, error: err.message };
      }
    },
  };
}
