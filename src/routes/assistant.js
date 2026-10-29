import { Router } from 'express';
import { answerQuestion } from '../assistant/ask.js';
import { draftForAction, sendLinks } from '../assistant/drafts.js';
import { localToday } from '../jira/classify.js';
import { serviceStatus } from '../monitor.js';

// Assistant endpoints. State-changing calls require a JSON body so a web page
// in your browser can't trigger them cross-site. Nothing here sends email or
// Teams messages to anyone, or changes Jira.
export function assistantRoutes({ store, config, scheduler, notifier, claude, briefings }) {
  const router = Router();

  router.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PATCH') && !req.is('application/json')) {
      return res.status(415).json({ error: "Send JSON with header 'Content-Type: application/json' (use -d '{}' for no options)" });
    }
    next();
  });

  router.get('/status', (req, res) => {
    const s = serviceStatus({ store, config, scheduler, notifier, claude });
    res.status(s.status === 'ok' ? 200 : 207).json(s);
  });

  router.post('/ask', async (req, res) => {
    res.json(await answerQuestion({ store, claude, question: req.body?.question }));
  });

  router.get('/briefings', (req, res) => {
    res.json(store.listBriefings(req.query.day || localToday()));
  });

  router.post('/briefings/:kind/run', async (req, res) => {
    res.json(await briefings.run(req.params.kind, { force: Boolean(req.body?.force) }));
  });

  router.post('/actions/:id/draft', async (req, res) => {
    const out = await draftForAction({
      store, claude, actionId: Number(req.params.id),
      channel: req.body?.channel ?? 'email', guidance: req.body?.guidance ?? '', myName: config.myName,
    });
    res.status(201).json(out);
  });

  router.get('/drafts', (req, res) => {
    res.json(store.listDrafts(req.query.status || 'pending'));
  });

  router.patch('/drafts/:id', (req, res) => {
    const ok = store.editDraft(Number(req.params.id), { subject: req.body?.subject, body: req.body?.body });
    if (!ok) return res.status(409).json({ error: 'Only pending drafts can be edited' });
    res.json(store.getDraft(Number(req.params.id)));
  });

  router.post('/drafts/:id/approve', (req, res) => {
    const id = Number(req.params.id);
    if (!store.approveDraft(id)) return res.status(409).json({ error: 'Only pending drafts can be approved' });
    const draft = store.getDraft(id);
    res.json({ draft, sendYourself: sendLinks(draft), note: 'Approved. Copy the text or use a link to send it yourself, then POST /drafts/:id/sent.' });
  });

  router.post('/drafts/:id/reject', (req, res) => {
    if (!store.rejectDraft(Number(req.params.id))) return res.status(409).json({ error: 'Only pending drafts can be rejected' });
    res.json(store.getDraft(Number(req.params.id)));
  });

  // Records that you sent an approved draft yourself.
  router.post('/drafts/:id/sent', (req, res) => {
    const id = Number(req.params.id);
    if (!store.claimDraftForSend(id) || !store.markDraftSent(id)) return res.status(409).json({ error: 'Only approved drafts can be marked sent' });
    res.json(store.getDraft(id));
  });

  router.use((err, req, res, next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return router;
}
