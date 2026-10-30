import { Router } from 'express';
import { listFeatures, addFeature, removeFeature } from '../reports/registry.js';

// The tracked-feature list behind the Feature report:
//   GET    /features              → tracked and removed features
//   POST   /features {key, note}  → add (verified in Jira) or re-add
//   DELETE /features/:key         → stop tracking (history kept)
// Changes need a JSON body or DELETE, so a web page can't trigger them cross-site.
// Nothing here changes Jira.
export function featureRoutes({ store, config, jiraClient }) {
  const router = Router();

  router.get('/', (req, res) => res.json(listFeatures(store, config)));

  router.post('/', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: "Send JSON with header 'Content-Type: application/json'" });
    const out = await addFeature({ store, config, client: jiraClient, key: req.body?.key, note: req.body?.note ?? null });
    res.status(out.result === 'added' ? 201 : 200).json(out);
  });

  router.delete('/:key', (req, res) => res.json(removeFeature({ store, config, key: req.params.key })));

  router.use((err, req, res, next) => {
    if (err.name === 'RegistryError') return res.status(err.status).json({ error: err.message });
    if (err.name === 'JiraError') return res.status(502).json({ error: err.message });
    next(err);
  });

  return router;
}
