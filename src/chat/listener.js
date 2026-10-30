// Two-way Teams chat by polling one chat with Graph (delegated Chat.Read).
// No public endpoint, Azure bot or paid service is needed: the service asks
// Graph for messages newer than its cursor every few seconds, answers the ones
// you wrote, and replies in the same chat (via the Workflows webhook, or as
// you via ChatMessage.Send).
//
// Reliability: each message is claimed once (duplicate protection); failed
// replies are retried on the next poll (up to 3 times); expired sign-in pauses
// the listener with one alert per day and resumes after `npm run ms:login`.

import { logger } from '../logger.js';
import { htmlToText } from '../text.js';
import { AuthRequiredError } from '../microsoft/auth.js';
import { BOT_PREFIX } from '../microsoft/chatSend.js';
import { dayKey } from '../time.js';

const log = logger.child({ component: 'chat-listener' });
const CURSOR_KEY = 'teams_chat';
const MAX_ATTEMPTS = 3;

export function createChatListener({ graph, store, handler, reply, chatId, pollSeconds = 20, notifyAlert = null, timeZone = 'America/New_York' }) {
  const attempts = new Map();
  let timer = null;
  let running = false;
  let me = null;

  async function poll() {
    if (running) return { skipped: 'busy' };
    running = true;
    const stats = { fetched: 0, answered: 0, failed: 0 };
    try {
      me ??= await graph.me();
      const state = store.getSyncState(CURSOR_KEY);
      if (!state?.cursor) {
        // First start: don't answer old history, only what arrives from now on.
        store.saveSyncSuccess(CURSOR_KEY, new Date().toISOString());
        return stats;
      }
      const cursor = state.cursor;
      const { items } = await graph.collect(`/chats/${encodeURIComponent(chatId)}/messages`, {
        query: { $top: 20, $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${cursor}` },
        limit: 60,
      });
      stats.fetched = items.length;
      const ordered = items.sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
      let newCursor = cursor;
      let retryFrom = null;

      for (const m of ordered) {
        if (m.lastModifiedDateTime > newCursor) newCursor = m.lastModifiedDateTime;
        const text = htmlToText(m.body?.contentType === 'html' ? m.body.content : m.body?.content ?? '').trim();
        const fromMe = m.from?.user?.id && m.from.user.id === me.id;
        if (!fromMe || m.messageType !== 'message' || m.deletedDateTime || !text || text.startsWith(BOT_PREFIX)) continue;
        if (m.createdDateTime <= cursor) continue; // an edit of an older message: don't answer twice
        if (!store.claimEvent('teams-chat', m.id)) continue;

        try {
          const answer = await handler.handle(text, { chatId });
          if (!answer) continue;
          await reply(answer);
          store.addChatTurn({ chatId, messageId: m.id, role: 'user', text });
          store.addChatTurn({ chatId, role: 'assistant', text: answer });
          stats.answered++;
          attempts.delete(m.id);
        } catch (err) {
          if (err instanceof AuthRequiredError) {
            store.releaseEvent('teams-chat', m.id);
            throw err;
          }
          const n = (attempts.get(m.id) ?? 0) + 1;
          attempts.set(m.id, n);
          stats.failed++;
          log.error('chat reply failed', { attempt: n, error: err.message });
          if (n < MAX_ATTEMPTS) {
            store.releaseEvent('teams-chat', m.id); // retried on the next poll
            retryFrom ??= m.createdDateTime;
          } else {
            await reply(`Sorry — I couldn't answer that after ${MAX_ATTEMPTS} tries (${err.message}). Please ask again.`).catch(() => {});
          }
        }
      }
      // Keep the cursor before any message that needs a retry.
      const next = retryFrom ? new Date(Date.parse(retryFrom) - 1).toISOString() : newCursor;
      store.saveSyncSuccess(CURSOR_KEY, next);
      return stats;
    } catch (err) {
      store.saveSyncError(CURSOR_KEY, err.message);
      if (err instanceof AuthRequiredError) {
        log.warn('teams chat paused: Microsoft sign-in required');
        store.raiseAlert({
          dedupeKey: `chat-auth:${dayKey(new Date(), timeZone)}`,
          severity: 'warning',
          title: 'Teams chat paused: Microsoft sign-in expired',
          detail: 'Run `npm run ms:login` on the Mac running the assistant; chat resumes automatically.',
        });
        await notifyAlert?.();
      } else {
        log.error('teams chat poll failed', { error: err.message });
      }
      return { ...stats, error: err.message };
    } finally {
      running = false;
    }
  }

  return {
    poll,
    start() {
      timer = setInterval(() => poll().catch(() => {}), pollSeconds * 1000);
      setTimeout(() => poll().catch(() => {}), 5_000).unref();
      log.info('teams chat listening', { pollSeconds });
    },
    stop() {
      clearInterval(timer);
    },
  };
}
