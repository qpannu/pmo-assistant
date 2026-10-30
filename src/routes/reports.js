import { Router } from 'express';
import { runReport, REPORTS } from '../reports/index.js';

// Jira reports, each on its own:
//   GET /reports                      → available reports
//   GET /reports/scrum?sprint=&board=      → JSON; add format=md for the text version
//   GET /reports/releases?version=&board=
// Running a report records a snapshot for "since last report" comparisons.
// Nothing here changes Jira.
export function reportRoutes({ store, config, jiraClient, claude }) {
  const router = Router();

  router.get('/', (req, res) => res.json({ reports: REPORTS, board: config.reports.boardId || null }));

  router.get('/:name', async (req, res) => {
    const { report, markdown } = await runReport(req.params.name, {
      client: jiraClient, store, claude, config,
      options: { sprint: req.query.sprint, version: req.query.version, board: req.query.board },
    });
    if (req.query.format === 'md') return res.type('text/markdown').send(markdown);
    res.json(report);
  });

  router.use((err, req, res, next) => {
    if (err.name === 'ReportError') return res.status(err.status).json({ error: err.message });
    if (err.name === 'JiraError') return res.status(502).json({ error: err.message });
    next(err);
  });

  return router;
}
