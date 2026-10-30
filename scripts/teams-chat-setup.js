// Helps you pick and verify the Teams chat the assistant listens to.
//   npm run chat:setup             → lists candidate chats (bot chats first)
//   npm run chat:setup -- <chatId> → verifies the assistant can read it and
//                                    shows your last messages there (read-only)
// Sends nothing.

import { config, msScopes } from '../src/config.js';
import { createMsAuth } from '../src/microsoft/auth.js';
import { createGraphClient } from '../src/microsoft/graph.js';
import { htmlToText } from '../src/text.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('warn');
const chatId = process.argv[2];

try {
  const graph = createGraphClient(createMsAuth({ ...config.ms, scopes: msScopes(config.ms, config.teamsChat) }));
  const me = await graph.me();

  if (!chatId) {
    const { items } = await graph.collect('/me/chats', {
      query: { $expand: 'members', $orderby: 'lastMessagePreview/createdDateTime desc', $top: 50 },
      limit: 100,
    });
    const rows = items.map((c) => {
      const others = (c.members ?? []).filter((m) => m.userId !== me.id).map((m) => m.displayName);
      const kind = c.id === '48:notes' ? 'notes to self'
        : c.chatType === 'oneOnOne' && !others.length ? 'app/bot chat (e.g. Workflows)' : `${c.chatType} with ${others.slice(0, 3).join(', ')}`;
      return { id: c.id, kind, topic: c.topic ?? '' };
    }).sort((a, b) => (a.kind.startsWith('app') ? -1 : 0) - (b.kind.startsWith('app') ? -1 : 0));
    console.log('\nCandidate chats (pick the Workflows bot chat you set up for notifications):\n');
    for (const r of rows.slice(0, 15)) console.log(`  ${r.kind.padEnd(34)} ${r.topic.padEnd(20)} ${r.id}`);
    console.log('\nThen: npm run chat:setup -- <chatId>\n');
  } else {
    const page = await graph.get(`/chats/${encodeURIComponent(chatId)}/messages`, { query: { $top: 10 } });
    const mine = (page.value ?? []).filter((m) => m.from?.user?.id === me.id);
    console.log(`\n✔ Can read chat ${chatId} (${page.value?.length ?? 0} recent messages, ${mine.length} from you).`);
    for (const m of mine.slice(0, 3)) console.log(`   you, ${m.createdDateTime}: ${htmlToText(m.body?.content ?? '').slice(0, 80)}`);
    console.log('\nIf a test message you typed in that chat appears above, set TEAMS_CHAT_ID to this id in .env and restart.\n');
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
