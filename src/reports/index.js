// Runs one Jira report on its own: fetch → compute facts → (optional Claude
// follow-up ordering) → save a snapshot → render. Each report is independent;
// there is no combined "all reports" output. Read-only towards Jira.

import { buildScrumReport, renderScrumReport } from './scrum.js';
import { buildReleaseReport, renderReleaseReport } from './releases.js';
import { buildFeatureReport, renderFeatureReport } from './features.js';
import { listFeatures } from './registry.js';
import { refineFollowUps } from './followups.js';
import { startOfLocalDay } from './snapshot.js';

export const REPORTS = ['scrum', 'releases', 'features'];

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
  const run = { scrum: runScrum, releases: runReleases, features: runFeatures }[name];
  return run({ client, store, claude, config, now, save, options });
}

function boardIdFrom(config, options) {
  const boardId = Number(options.board ?? config.reports.boardId);
  if (!boardId) throw new ReportError('No board configured: set JIRA_BOARD_ID in .env (or pass a board id)', 400);
  return boardId;
}

async function runScrum({ client, store, claude, config, now, save, options }) {
  const boardId = boardIdFrom(config, options);
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

async function runReleases({ client, store, claude, config, now, save, options }) {
  const boardId = boardIdFrom(config, options);
  const prev = store.lastReportSnapshot('releases', boardId, startOfLocalDay(now));
  const report = await buildReleaseReport({
    client, boardId, now,
    versionFilter: options.version ?? null,
    prefixes: config.reports.releasePrefixes ?? [],
    previous: prev ? { takenAt: prev.taken_at, versions: prev.data.versions } : null,
    rules: { dueSoonDays: config.jira.releaseWindowDays, activeDays: config.reports.releaseActiveDays },
  });

  const facts = {
    totals: report.totals,
    releases: report.active.slice(0, 15).map((x) => ({
      name: x.name, target: x.releaseDate, dateStatus: x.dateStatus, open: x.open, readiness: x.readiness.status, risks: x.risks,
      blocked: x.blocked.slice(0, 3).map((b) => ({ key: b.key, owner: b.owner, why: b.why })),
      urgentBugs: x.urgentBugs.slice(0, 3).map((b) => ({ key: b.key, owner: b.owner, priority: b.priority })),
    })),
  };
  const refined = await refineFollowUps({ claude, purpose: 'report:releases', facts, followUps: report.followUps });
  report.followUps = refined.followUps;
  report.followUpsSource = refined.source;

  const all = [...report.active, ...report.dormant, ...report.complete];
  const snapshot = { versions: Object.fromEntries(all.map((x) => [x.name, { releaseDate: x.releaseDate, issues: x.snapshot }])) };
  for (const x of all) delete x.snapshot;
  if (save && !options.version && all.length) store.saveReportSnapshot('releases', boardId, snapshot, now.toISOString());

  return { report, markdown: renderReleaseReport(report) };
}

async function runFeatures({ client, store, claude, config, now, save, options }) {
  const { tracked, removed } = listFeatures(store, config);
  const only = options.feature ? String(options.feature).toUpperCase() : null;
  const features = only ? tracked.filter((f) => f.key === only) : tracked;
  if (only && !features.length) throw new ReportError(`${only} is not a tracked feature (npm run features -- list)`, 404);

  const prev = store.lastReportSnapshot('features', 'registry', startOfLocalDay(now));
  const report = await buildFeatureReport({
    client, now, features, removed,
    boardId: config.reports.boardId || null,
    previous: prev ? { takenAt: prev.taken_at, features: prev.data.features } : null,
    rules: { dueSoonDays: config.jira.releaseWindowDays, devHoursPerDay: config.reports.devHoursPerDay, qaHoursPerDay: config.reports.qaHoursPerDay },
  });

  for (const f of report.features) store.updateTrackedFeatureInfo(f.key, { summary: f.summary, type: f.type });

  const facts = report.features.map((f) => ({
    feature: f.key, summary: f.summary, health: f.health.status, donePct: f.totals.donePct, open: f.totals.open, risks: f.risks,
    devPct: f.dev.pct, qaPct: f.qa.pct, estimatedFinish: f.timeline.estimate?.finish ?? null,
    epics: f.epics.filter((e) => e.flags.length).map((e) => ({ key: e.key, owner: e.owner, flags: e.flags })),
    blockers: f.blockers.slice(0, 5).map((b) => ({ key: b.key, owner: b.owner, why: b.why })),
  }));
  const refined = await refineFollowUps({ claude, purpose: 'report:features', facts, followUps: report.followUps });
  report.followUps = refined.followUps;
  report.followUpsSource = refined.source;

  // Snapshots keep removed features' history; a single-feature run isn't saved.
  const snapshot = { features: Object.fromEntries(report.features.map((f) => [f.key, f.snapshot])) };
  for (const f of report.features) delete f.snapshot;
  if (save && !only) store.saveReportSnapshot('features', 'registry', snapshot, now.toISOString());

  return { report, markdown: renderFeatureReport(report) };
}
