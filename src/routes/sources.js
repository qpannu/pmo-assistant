import { Router } from 'express';

// GET /overview (local data, no API call) and POST /sync (run now; joins a
// sync already in progress). Used for Jira, Outlook and Teams.
export function sourceRoutes({ task, scheduler, overview, setupHint }) {
  const router = Router();

  router.get('/overview', (req, res) => {
    res.json(overview());
  });

  router.post('/sync', async (req, res) => {
    if (!scheduler.has(task)) return res.status(503).json({ error: `${task} is not configured. ${setupHint}` });
    try {
      res.json(await scheduler.runNow(task));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
