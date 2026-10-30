import { Router } from 'express';
import { setVerdict, recentRisks } from '../reports/feedback.js';

// Feedback on reported risks / follow-ups:
//   GET  /risks?report=&days=           → recently raised, with verdicts
//   POST /risks/:ref {verdict, note}   → valid | dismissed | resolved | clear
// Changes need a JSON body, so a web page can't trigger them cross-site.
// Only changes how reports rank and show follow-ups; never changes Jira.
export function riskRoutes({ store }) {
  const router = Router();

  router.get('/', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
    res.json(recentRisks(store, { report: req.query.report || null, days }));
  });

  router.post('/:ref', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: "Send JSON with header 'Content-Type: application/json'" });
    res.json(setVerdict(store, req.params.ref, req.body?.verdict ?? null, req.body?.note ?? null));
  });

  router.use((err, req, res, next) => {
    if (err.name === 'FeedbackError') return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return router;
}
