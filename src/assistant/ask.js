// Answers PMO questions ("what's blocking 8.886.22.10?", "what do I owe Randy?").
// Ordinary code picks the relevant records (Jira keys, keyword overlap); Claude
// only sees that short list — never the whole database.

import { extractJiraKeys, truncate } from '../text.js';
import { runPriorityEngine } from '../priority/engine.js';
import { compactItem, releasesAtRisk } from '../briefing/context.js';

const STOP = new Set('what which when where who whom whose why how does have has had with from that this there their about into over under for and the are was were will would should could can any all our your my me you is it of on in to a an or be by at as do'.split(' '));
const MAX_ITEMS = 15;

const words = (s) => (s.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

const SYSTEM = `You answer questions from a senior program manager about their projects, releases and pending work.
Answer from the records provided only. Be direct: lead with the answer, then the supporting facts (ticket keys, people, dates). If the records don't contain the answer, say so and suggest where to look. Keep it under 150 words unless the question asks for a list.`;

// Action items and Jira issues relevant to a question (Jira keys, keywords).
export function relevantRecords(store, report, q) {
  const items = [...report.critical, ...report.waitingOnMe, ...report.releaseRisks, ...report.followUps];
  const keys = new Set(extractJiraKeys(q.toUpperCase()));
  const terms = words(q);

  const relevance = (text) => {
    const t = text.toLowerCase();
    let s = 0;
    for (const k of keys) if (t.includes(k.toLowerCase())) s += 10;
    for (const w of terms) if (t.includes(w)) s += 1;
    return s;
  };

  const actions = items
    .map((i) => ({ i, s: relevance(`${i.title} ${i.sources.map((x) => x.text).join(' ')}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.i.score - a.i.score)
    .slice(0, MAX_ITEMS);

  // Jira issues that aren't action items still answer "status of X" questions.
  const issues = store.listItems({ source: 'jira', kind: 'issue' })
    .filter((r) => r.data.tracked)
    .map((r) => ({ r, s: relevance(`${r.data.key} ${r.data.summary} ${r.data.fixVersions.map((v) => v.name).join(' ')}`) }))
    .filter((x) => x.s >= (keys.size ? 10 : 2))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map(({ r }) => ({
      key: r.data.key, summary: truncate(r.data.summary, 100), status: r.data.status, priority: r.data.priority,
      assignee: r.data.assignee?.name ?? null, due: r.data.dueDate, releases: r.data.fixVersions.map((v) => v.name), url: r.url,
    }));
  return { items, actions, issues };
}

export async function answerQuestion({ store, claude, question, now = new Date() }) {
  const q = String(question ?? '').trim();
  if (!q) throw Object.assign(new Error('question is required'), { status: 400 });

  const report = await runPriorityEngine(store, { now });
  const { items, actions, issues } = relevantRecords(store, report, q);

  const context = {
    today: now.toISOString().slice(0, 10),
    counts: report.counts,
    releasesAtRisk: releasesAtRisk(store),
    actionItems: (actions.length ? actions.map((x) => x.i) : items.slice(0, 8)).map((i) => compactItem(i)),
    jiraIssues: issues,
  };
  const references = [
    ...actions.map((x) => ({ title: x.i.title, url: x.i.sources[0]?.url })),
    ...issues.map((x) => ({ title: `${x.key}: ${x.summary}`, url: x.url })),
  ];

  if (!claude.enabled) {
    return { method: 'rules', answer: 'Claude is off (CLAUDE_ENABLED=false). These are the most relevant records:', references, context };
  }
  try {
    const { text } = await claude.complete({ purpose: 'ask', system: SYSTEM, user: `Question: ${q}\n\nRecords:\n${JSON.stringify(context)}` });
    return { method: 'claude', answer: text, references };
  } catch (err) {
    return { method: 'rules-fallback', answer: `Claude unavailable (${err.message}). These are the most relevant records:`, references, context };
  }
}
