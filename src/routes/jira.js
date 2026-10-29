import { Router } from 'express';
import { jiraOverview } from '../jira/sync.js';

export function jiraRoutes({ store, scheduler }) {
  const router = Router();

  // Everything the assistant currently knows from Jira (local data, no API call).
  router.get('/overview', (req, res) => {
    res.json(jiraOverview(store));
  });

  // Trigger a sync now. Read-only against Jira; joins a sync already running.
  router.post('/sync', async (req, res) => {
    if (!scheduler.has('jira')) {
      return res.status(503).json({ error: 'Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env.' });
    }
    try {
      res.json(await scheduler.runNow('jira'));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
