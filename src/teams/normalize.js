// Graph chatMessage → compact stored record. Reactions and lastModified are
// left out so they don't make a message look changed.

import { extractJiraKeys, htmlToText, truncate } from '../text.js';

const MAX_TEXT = 1000;

// Chat messages have no webUrl in Graph; this deep link opens them in Teams.
export function chatMessageLink(chatId, messageId) {
  const ctx = encodeURIComponent(JSON.stringify({ contextType: 'chat' }));
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/${messageId}?context=${ctx}`;
}

// `where`: { chatId, chatType, chatTopic } for chats, or { channel: { teamId, channelId, name } }.
export function normalizeChatMessage(m, where) {
  const raw = m.body?.contentType === 'html' ? htmlToText(m.body?.content ?? '') : (m.body?.content ?? '');
  const text = truncate(raw.replace(/\s+/g, ' ').trim(), MAX_TEXT);
  const isChannel = Boolean(where.channel);
  const rootId = m.replyToId ?? m.id;
  return {
    id: m.id,
    chatId: where.chatId ?? null,
    chatType: isChannel ? 'channel' : where.chatType ?? null, // oneOnOne | group | meeting | channel
    chatTopic: isChannel ? where.channel.name : where.chatTopic ?? null,
    channel: where.channel ?? null,
    replyToId: m.replyToId ?? null,
    threadKey: isChannel ? `channel:${where.channel.channelId}:${rootId}` : `chat:${where.chatId}`,
    from: m.from?.user
      ? { id: m.from.user.id, name: m.from.user.displayName ?? null, isBot: false }
      : { id: m.from?.application?.id ?? null, name: m.from?.application?.displayName ?? null, isBot: true },
    createdAt: m.createdDateTime,
    deleted: Boolean(m.deletedDateTime),
    isSystem: m.messageType !== 'message',
    importance: m.importance ?? 'normal',
    subject: m.subject ?? null,
    text,
    mentionIds: (m.mentions ?? []).map((x) => x.mentioned?.user?.id).filter(Boolean),
    webUrl: m.webUrl ?? (where.chatId ? chatMessageLink(where.chatId, m.id) : null),
    jiraKeys: extractJiraKeys(`${m.subject ?? ''} ${text}`),
  };
}
