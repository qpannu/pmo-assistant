import { Router } from 'express';

const STATUSES = new Set(['open', 'done', 'dismissed', 'snoozed']);

// Action items across Jira, Outlook and Teams. Changing a status only updates
// the local database — nothing is sent anywhere.
export function actionRoutes({ store }) {
  const router = Router();

  router.get('/', (req, res) => {
    const actions = store.listOpenActions({ project: req.query.project || undefined })
      .map((a) => ({ ...a, sources: store.listActionSources(a.id) }));
    res.json({ count: actions.length, actions });
  });

  // JSON only: browsers can't send that cross-site without a CORS preflight,
  // which this server never approves.
  router.post('/:id/status', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const id = Number(req.params.id);
    const { status, snoozedUntil } = req.body ?? {};
    if (!Number.isInteger(id) || !store.getActionItem(id)) return res.status(404).json({ error: 'Action item not found' });
    if (!STATUSES.has(status)) return res.status(400).json({ error: `status must be one of ${[...STATUSES].join(', ')}` });
    if (status === 'snoozed' && Number.isNaN(Date.parse(snoozedUntil))) return res.status(400).json({ error: 'snoozedUntil (ISO date) is required' });
    store.setActionStatus(id, status, { snoozedUntil: status === 'snoozed' ? new Date(snoozedUntil).toISOString() : null });
    res.json(store.getActionItem(id));
  });

  return router;
}
