import { Router } from 'express';
import { runPriorityEngine } from '../priority/engine.js';
import { formatReport } from '../priority/format.js';

// GET  /priorities           ranked list (JSON, or ?format=text); raises no alerts
// POST /priorities/run       rank and record new critical alerts (deduplicated)
// GET  /alerts               unacknowledged alerts
// POST /alerts/:id/ack       acknowledge an alert (local only)
export function priorityRoutes({ store, reasoner = null }) {
  const router = Router();

  const respond = (req, res, report) => (req.query.format === 'text'
    ? res.type('text/plain').send(formatReport(report))
    : res.json(report));

  router.get('/priorities', async (req, res) => {
    respond(req, res, await runPriorityEngine(store, { reasoner }));
  });

  router.post('/priorities/run', async (req, res) => {
    respond(req, res, await runPriorityEngine(store, { reasoner, raiseAlerts: true }));
  });

  router.get('/alerts', (req, res) => {
    res.json(store.listActiveAlerts());
  });

  router.post('/alerts/:id/ack', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const ok = store.acknowledgeAlert(Number(req.params.id));
    res.status(ok ? 200 : 404).json({ acknowledged: ok });
  });

  return router;
}
