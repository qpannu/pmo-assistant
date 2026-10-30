// Posts the assistant's replies into ONE configured Teams chat (reply mode
// "graph", delegated ChatMessage.Send). This is the only Graph write in the
// project, and it is locked to the chat id given at creation — it cannot post
// anywhere else. Replies appear as you, prefixed with the bot marker.

import { GRAPH } from './graph.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'teams-chat-send' });
export const BOT_PREFIX = '🤖 PMO Assistant';
const RETRYABLE = new Set([429, 502, 503, 504]);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal markdown → Teams HTML: bold, links, line breaks.
export function toTeamsHtml(markdown) {
  return esc(markdown)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br>');
}

export function createChatSender(auth, chatId, { fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  if (!chatId) throw new Error('chatId is required');
  const url = `${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`;

  return async function send(markdown) {
    const body = JSON.stringify({ body: { contentType: 'html', content: `<b>${BOT_PREFIX}</b><br>${toTeamsHtml(markdown)}` } });
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await auth.getAccessToken();
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return { delivered: true };
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await auth.getAccessToken({ forceRefresh: true });
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < 3) {
        await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
        continue;
      }
      const hint = res.status === 403 ? ' (ChatMessage.Send not granted — run `npm run ms:login` after adding it)' : '';
      log.error('chat reply failed', { status: res.status });
      throw new Error(`Teams chat reply failed: HTTP ${res.status}${hint}`);
    }
  };
}
