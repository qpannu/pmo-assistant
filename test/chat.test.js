import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { setLogLevel } from '../src/logger.js';
import { createClaude } from '../src/claude/client.js';
import { createChatHandler, HELP } from '../src/chat/handler.js';
import { createChatListener } from '../src/chat/listener.js';
import { createChatSender, toTeamsHtml, BOT_PREFIX } from '../src/microsoft/chatSend.js';
import { AuthRequiredError } from '../src/microsoft/auth.js';
import { clearScopeCache } from '../src/jira/scope.js';
import { seedSample } from './fixtures/sample-data.js';

setLogLevel('error');

const CHAT = '19:abc_def@unq.gbl.spaces';
const ME = { id: 'u-me', displayName: 'Pat Doe', mail: 'pat@example.com' };

function fakeClaude(texts = []) {
  const calls = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          create: async (req) => {
            calls.push(req);
            const text = req.output_config.format
              ? JSON.stringify({ subject: 'Release date', body: 'Hi Randy,\n\nQuick update: [date]. \n\nThanks' })
              : texts.shift() ?? 'Focus on REST-900 first ([REST-900](L1)).';
            return { stop_reason: 'end_turn', model: req.model, usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text }] };
          },
        },
      },
    },
  };
}

const fakeJira = (issues) => ({
  searches: 0,
  async search() { this.searches++; return { issues, truncated: false }; },
  browseUrl: (k) => `https://example.atlassian.net/browse/${k}`,
});

const jiraIssue = (key, status, assignee, extra = {}) => ({
  id: key, key,
  fields: {
    summary: `Summary ${key}`, status: { name: status, statusCategory: { key: 'indeterminate' } }, priority: { name: extra.priority ?? 'Medium' },
    issuetype: { name: extra.type ?? 'Story' }, assignee: assignee ? { accountId: assignee, displayName: assignee } : null,
    duedate: extra.due ?? null, issuelinks: [], labels: [], fixVersions: [], comment: { comments: [] }, updated: new Date().toISOString(),
  },
});

let store, cfg;
beforeEach(() => {
  store = createStore(openDb(':memory:'));
  seedSample(store);
  cfg = { ...loadConfig(), pmoScopes: { ezCater: 'parentEpic in (1)' }, myManager: { name: '', email: '' }, myName: 'Pat' };
  clearScopeCache();
});

describe('chat handler', () => {
  test('help and empty messages', async () => {
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'm', enabled: false }), config: cfg });
    assert.equal(await h.handle('help', { chatId: CHAT }), HELP);
    assert.equal(await h.handle('   ', { chatId: CHAT }), null);
  });

  test('a question gets one Claude call with compact context; follow-ups carry the conversation', async () => {
    const fake = fakeClaude(['Start with REST-900 ([REST-900](L1)).', 'The other one is the 8.9.1 release.']);
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'claude-opus-5-5', client: fake.client }), config: cfg });

    const a1 = await h.handle('What should I focus on today?', { chatId: CHAT });
    assert.match(a1, /\]\(https:\/\//, 'link id expanded to a real URL');
    assert.equal(fake.calls.length, 1);
    const sent = fake.calls[0].messages[0].content;
    assert.ok(!sent.includes('https://'), 'URLs are not sent to Claude');
    assert.ok(sent.length < 12000, 'concise');

    store.addChatTurn({ chatId: CHAT, role: 'user', text: 'What should I focus on today?' });
    store.addChatTurn({ chatId: CHAT, role: 'assistant', text: a1 });
    await h.handle('and the other one?', { chatId: CHAT });
    assert.match(fake.calls[1].messages[0].content, /Conversation so far:\nMe: What should I focus on today\?/);
  });

  test('without Claude, common questions are answered by rules', async () => {
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'm', enabled: false }), config: cfg });
    assert.match(await h.handle('What decisions are waiting for me?', { chatId: CHAT }), /Waiting on you[\s\S]*Approval requested by Randy/);
    assert.match(await h.handle('What is blocking the next POS release?', { chatId: CHAT }), /POS 8\.9\.1.*critical.*blockers REST-901/);
    assert.match(await h.handle('What changed since yesterday?', { chatId: CHAT }), /Last 24 hours/);
  });

  test('ezCater questions use a live Jira snapshot; unknown teams are reported as missing', async () => {
    const jira = fakeJira([jiraIssue('EZ-1', 'Dev in Progress', 'Ben'), jiraIssue('EZ-2', 'Blocked', null), jiraIssue('EZ-3', 'Ready for QA', 'Matt', { priority: 'High' })]);
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'm', enabled: false }), config: cfg, jiraClient: jira });
    const r = await h.handle('Summarize the latest ezCater progress', { chatId: CHAT });
    assert.match(r, /ezCater\*\* — 3 open/);
    assert.match(r, /Blocked 1, unassigned 1/);
    await h.handle('ezcater status again', { chatId: CHAT });
    assert.equal(jira.searches, 1, 'cached for follow-ups');

    assert.match(await h.handle('What is the status of Team Tesla?', { chatId: CHAT }), /No Jira scope is configured for "Team Tesla"/);
  });

  test('fresh data: an old Jira sync is refreshed before answering', async () => {
    let ran = 0;
    const scheduler = { has: (n) => n === 'jira', runNow: async () => { ran++; } };
    store.saveSyncSuccess('jira', '{}');
    store.transaction(() => {}); // no-op; last_success_at is "now" → fresh
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'm', enabled: false }), config: cfg, scheduler });
    await h.handle('What should I focus on today?', { chatId: CHAT });
    assert.equal(ran, 0, 'fresh enough');
    openDb; // keep linter quiet
    const old = createStore(openDb(':memory:'));
    seedSample(old);
    const h2 = createChatHandler({ store: old, claude: createClaude({ store: old, model: 'm', enabled: false }), config: cfg, scheduler });
    await h2.handle('What should I focus on today?', { chatId: CHAT });
    assert.equal(ran, 1, 'never synced → sync first');
  });

  test('drafts are returned for review, never sent; approval gives send links', async () => {
    const fake = fakeClaude();
    const claude = createClaude({ store, model: 'claude-opus-5-5', client: fake.client });
    const noManager = createChatHandler({ store, claude, config: cfg });
    assert.match(await noManager.handle('Draft a response to my manager about the release date', { chatId: CHAT }), /Set MY_MANAGER_NAME/);

    const h = createChatHandler({ store, claude, config: { ...cfg, myManager: { name: 'Randy Brown', email: 'randy@example.com' } } });
    const r = await h.handle('Draft a response to my manager about the release date', { chatId: CHAT });
    assert.match(r, /Draft #(\d+)\*\* — email to Randy Brown — \*\*not sent\*\*/);
    const id = Number(r.match(/Draft #(\d+)/)[1]);
    assert.equal(store.getDraft(id).status, 'pending');
    assert.ok(JSON.parse(fake.calls[0].messages[0].content).theirRecentMessages.some((m) => /Go\/No-Go/.test(m)), 'uses what Randy sent');

    assert.match(await h.handle(`sent draft ${id}`, { chatId: CHAT }), /must be approved first/);
    const approved = await h.handle(`approve draft ${id}`, { chatId: CHAT });
    assert.match(approved, /Send it yourself/);
    assert.match(approved, /outlook\.office\.com\/mail\/deeplink\/compose\?to=randy%40example\.com/);
    assert.match(await h.handle(`sent draft ${id}`, { chatId: CHAT }), /Marked draft #\d+ as sent/);
    assert.match(await h.handle('drafts', { chatId: CHAT }), /No drafts waiting/);
  });

  test('drafting for an action item by id', async () => {
    const h = createChatHandler({ store, claude: createClaude({ store, model: 'm', enabled: false }), config: cfg });
    const approval = store.listOpenActions().find((a) => /Randy/.test(a.title));
    const r = await h.handle(`draft an email reply to #${approval.id} approving it`, { chatId: CHAT });
    assert.match(r, /email to Randy — \*\*not sent\*\*/);
    assert.match(await h.handle(`reject draft ${r.match(/#(\d+)/)[1]}`, { chatId: CHAT }), /rejected\. Nothing was sent/);
  });
});

describe('chat listener', () => {
  const msg = (id, text, { from = ME.id, at, type = 'message', app = false } = {}) => ({
    id, messageType: type, createdDateTime: at, lastModifiedDateTime: at, deletedDateTime: null,
    from: app ? { application: { id: 'workflows' } } : { user: { id: from } },
    body: { contentType: 'html', content: `<p>${text}</p>` },
  });

  function fakeGraph(messages) {
    return {
      calls: 0,
      error: null,
      me: async () => ME,
      async collect(url, { query }) {
        this.calls++;
        if (this.error) throw this.error;
        assert.equal(url, `/chats/${encodeURIComponent(CHAT)}/messages`);
        const since = query.$filter.replace('lastModifiedDateTime gt ', '');
        return { items: messages.filter((m) => m.lastModifiedDateTime > since) };
      },
    };
  }

  test('answers only my new messages, once each, in order', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const later = (s) => new Date(Date.now() + s * 1000).toISOString();
    const messages = [msg('old', 'old question', { at: t0 })];
    const graph = fakeGraph(messages);
    const replies = [];
    const handled = [];
    const listener = createChatListener({
      graph, store, chatId: CHAT,
      handler: { handle: async (t) => { handled.push(t); return `answer to ${t}`; } },
      reply: async (t) => { replies.push(t); },
    });

    assert.deepEqual(await listener.poll(), { fetched: 0, answered: 0, failed: 0 }, 'first poll only sets the cursor');
    messages.push(
      msg('m1', 'What should I focus on today?', { at: later(1) }),
      msg('m2', 'hello from someone else', { at: later(2), from: 'u-other' }),
      msg('m3', 'card from the bot', { at: later(3), app: true }),
      msg('m4', `${BOT_PREFIX} previous reply`, { at: later(4) }),
      msg('m5', 'joined', { at: later(5), type: 'systemEventMessage' }),
      msg('m6', 'What changed since yesterday?', { at: later(6) }),
    );
    const s = await listener.poll();
    assert.equal(s.answered, 2);
    assert.deepEqual(handled, ['What should I focus on today?', 'What changed since yesterday?']);
    assert.equal(store.recentChatTurns(CHAT).length, 4, 'conversation kept');

    // Same messages seen again (e.g. edited, or overlapping poll) → no duplicate replies.
    messages[1].lastModifiedDateTime = later(10);
    await listener.poll();
    assert.equal(replies.length, 2);
  });

  test('a failed reply is retried on the next poll; after 3 failures you get an apology', async () => {
    const later = (s) => new Date(Date.now() + s * 1000).toISOString();
    const messages = [];
    const graph = fakeGraph(messages);
    const sent = [];
    let failures = 2;
    const listener = createChatListener({
      graph, store, chatId: CHAT,
      handler: { handle: async (t) => `answer: ${t}` },
      reply: async (t) => { if (failures-- > 0) throw new Error('webhook 503'); sent.push(t); },
    });
    await listener.poll();
    messages.push(msg('r1', 'status?', { at: later(1) }));
    assert.equal((await listener.poll()).failed, 1);
    assert.equal((await listener.poll()).failed, 1);
    assert.equal((await listener.poll()).answered, 1);
    assert.deepEqual(sent, ['answer: status?']);

    failures = 99;
    messages.push(msg('r2', 'again?', { at: later(5) }));
    for (let i = 0; i < 3; i++) await listener.poll();
    assert.equal((await listener.poll()).answered, 0);
  });

  test('expired sign-in pauses chat with one alert per day, and resumes', async () => {
    const graph = fakeGraph([]);
    let notified = 0;
    const listener = createChatListener({
      graph, store, chatId: CHAT, handler: { handle: async () => 'x' }, reply: async () => {},
      notifyAlert: async () => { notified++; },
    });
    await listener.poll();
    graph.error = new AuthRequiredError();
    await listener.poll();
    await listener.poll();
    const alerts = store.listActiveAlerts().filter((a) => /sign-in expired/.test(a.title));
    assert.equal(alerts.length, 1, 'one alert per day');
    assert.equal(notified, 2);
    graph.error = null;
    assert.equal((await listener.poll()).error, undefined, 'resumes after npm run ms:login');
  });
});

describe('graph reply mode', () => {
  test('posts only to the configured chat, as HTML with the bot marker', async () => {
    const calls = [];
    const auth = { getAccessToken: async () => 'tok' };
    const send = createChatSender(auth, CHAT, { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201 }; } });
    await send('**Top** <script> [REST-1](https://x.example/REST-1)');
    assert.equal(calls[0].url, `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT)}/messages`);
    assert.equal(calls[0].opts.method, 'POST');
    const html = JSON.parse(calls[0].opts.body).body.content;
    assert.match(html, /^<b>🤖 PMO Assistant<\/b><br><b>Top<\/b> &lt;script&gt; <a href="https:\/\/x\.example\/REST-1">REST-1<\/a>$/);
  });

  test('explains a missing ChatMessage.Send permission', async () => {
    const send = createChatSender({ getAccessToken: async () => 't' }, CHAT, { fetchImpl: async () => ({ ok: false, status: 403 }) });
    await assert.rejects(send('x'), /ChatMessage\.Send not granted/);
  });

  test('markdown conversion only links https URLs', () => {
    assert.equal(toTeamsHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  });
});
