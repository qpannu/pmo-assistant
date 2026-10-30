import { Router } from 'express';
import { runReport, REPORTS } from '../reports/index.js';

// Jira reports, each on its own:
//   GET /reports                      → available reports
//   GET /reports/scrum?sprint=&board=      → JSON; add format=md for the text version
//   GET /reports/releases?version=&board=
//   GET /reports/features?feature=   (tracked list: /features)
//   GET /reports/prod
// Running a report records a snapshot for "since last report" comparisons.
// Nothing here changes Jira.
export function reportRoutes({ store, config, jiraClient, claude }) {
  const router = Router();

  router.get('/', (req, res) => res.json({ reports: REPORTS, board: config.reports.boardId || null }));

  // Results are kept for a few minutes so page refreshes don't re-query Jira;
  // concurrent requests for the same report share one run. ?fresh=1 skips the cache.
  const cache = new Map();
  const CACHE_MS = 5 * 60_000;
  const run = (name, options, fresh) => {
    const key = JSON.stringify([name, options]);
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = runReport(name, { client: jiraClient, store, claude, config, options });
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
  };

  router.get('/:name', async (req, res) => {
    const options = { sprint: req.query.sprint, version: req.query.version, feature: req.query.feature, board: req.query.board };
    const { report, markdown } = await run(req.params.name, options, req.query.fresh === '1');
    if (req.query.format === 'md') return res.type('text/markdown').send(markdown);
    res.json(report);
  });

  router.use((err, req, res, next) => {
    if (err.name === 'ReportError' || err.name === 'RegistryError') return res.status(err.status).json({ error: err.message });
    if (err.name === 'JiraError') return res.status(502).json({ error: err.message });
    next(err);
  });

  return router;
}
