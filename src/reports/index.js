// Runs one Jira report on its own: fetch → compute facts → (optional Claude
// follow-up ordering) → save a snapshot → render. Each report is independent;
// there is no combined "all reports" output. Read-only towards Jira.

import { buildScrumReport, renderScrumReport } from './scrum.js';
import { refineFollowUps } from './followups.js';
import { startOfLocalDay } from './snapshot.js';

export const REPORTS = ['scrum'];

export class ReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReportError';
    this.status = status;
  }
}

export async function runReport(name, { client, store, claude = null, config, now = new Date(), save = true, options = {} }) {
  if (!REPORTS.includes(name)) throw new ReportError(`Unknown report "${name}". Available: ${REPORTS.join(', ')}`, 404);
  if (!client) throw new ReportError('Jira is not configured (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)', 503);
  return runScrum({ client, store, claude, config, now, save, options });
}

async function runScrum({ client, store, claude, config, now, save, options }) {
  const boardId = Number(options.board ?? config.reports.boardId);
  if (!boardId) throw new ReportError('No board configured: set JIRA_BOARD_ID in .env (or pass a board id)', 400);

  const prev = store.lastReportSnapshot('scrum', boardId, startOfLocalDay(now));
  const report = await buildScrumReport({
    client, boardId, now,
    sprintFilter: options.sprint ?? null,
    sprintPrefix: config.reports.sprintPrefix ?? '',
    previous: prev ? { takenAt: prev.taken_at, sprints: prev.data.sprints } : null,
    rules: { staleDays: config.reports.staleDays, carryoverSprints: config.reports.carryoverSprints },
  });

  for (const s of report.sprints) {
    const facts = {
      sprint: s.name, end: s.end?.slice(0, 10), daysLeft: s.daysLeft, health: s.health,
      byPhase: s.byPhase, donePct: s.donePct,
      blockers: s.blockers.slice(0, 10).map((b) => ({ key: b.key, owner: b.owner, why: b.why })),
      atRisk: s.atRisk.slice(0, 10).map((i) => ({ key: i.key, owner: i.owner, reasons: i.reasons })),
    };
    const { followUps, source } = await refineFollowUps({ claude, purpose: 'report:scrum', facts, followUps: s.followUps });
    s.followUps = followUps;
    s.followUpsSource = source;
  }

  const snapshot = { sprints: Object.fromEntries(report.sprints.map((s) => [s.id, { name: s.name, issues: s.snapshot }])) };
  for (const s of report.sprints) delete s.snapshot;
  // A filtered run covers only some sprints; saving it would hide the others from tomorrow's diff.
  if (save && !options.sprint && report.sprints.length) store.saveReportSnapshot('scrum', boardId, snapshot, now.toISOString());

  return { report, markdown: renderScrumReport(report) };
}
