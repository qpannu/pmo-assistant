import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatMessage } from '../src/teams/normalize.js';
import { classifyChatMessage } from '../src/teams/classify.js';
import { syncTeams, teamsOverview } from '../src/teams/sync.js';
import { myIdentity } from '../src/outlook/classify.js';
import { syncActions } from '../src/actions.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');

const ME = { id: 'u-me', displayName: 'Qaiser Pannu', mail: 'qp@corp.com' };
const me = myIdentity(ME);
const ms = { teamsLookbackDays: 7, replyWindowDays: 7, maxMessagesPerSync: 500, teamsChannels: [] };
const NOW = new Date('2026-10-29T15:00:00Z');

let seq = 0;
function gmsg({ id = `t${++seq}`, from = 'u-alice', name = 'Alice', html, text = '', mentions = [], at = '2026-10-29T10:00:00Z',
  replyToId = null, importance = 'normal', type = 'message', bot = false, deleted = false } = {}) {
  return {
    id, replyToId, messageType: type, importance,
    createdDateTime: at, lastModifiedDateTime: at, deletedDateTime: deleted ? at : null,
    from: bot ? { application: { id: 'bot', displayName: 'Bot' } } : { user: { id: from, displayName: name } },
    body: html ? { contentType: 'html', content: html } : { contentType: 'text', content: text },
    mentions: mentions.map((uid) => ({ mentioned: { user: { id: uid } } })),
  };
}
const inChat = (o, chatType = 'oneOnOne', chatTopic = null) => normalizeChatMessage(gmsg(o), { chatId: 'chat1', chatType, chatTopic });
const classify = (msg, thread = [msg]) => classifyChatMessage(msg, thread, me, ms, NOW).signals;

describe('normalize', () => {
  test('HTML, mentions, Jira keys and a deep link to the message', () => {
    const m = inChat({ id: '1700', html: '<p><at id="0">Qaiser</at> can you check REST-21533?</p>', mentions: ['u-me'] }, 'group', 'POS release');
    assert.equal(m.text, 'Qaiser can you check REST-21533?');
    assert.deepEqual(m.mentionIds, ['u-me']);
    assert.deepEqual(m.jiraKeys, ['REST-21533']);
    assert.equal(m.threadKey, 'chat:chat1');
    assert.match(m.webUrl, /^https:\/\/teams\.microsoft\.com\/l\/message\/chat1\/1700\?context=/);
  });

  test('channel replies share the root thread and keep Graph webUrl', () => {
    const where = { channel: { teamId: 'T', channelId: 'C', name: 'Eng / Releases' } };
    const reply = normalizeChatMessage({ ...gmsg({ id: 'r1', replyToId: 'root1' }), webUrl: 'https://teams.microsoft.com/l/message/C/r1' }, where);
    assert.equal(reply.threadKey, 'channel:C:root1');
    assert.equal(reply.webUrl, 'https://teams.microsoft.com/l/message/C/r1');
  });
});

describe('classify', () => {
  test('@mention with a request needs a response; plain mention does not', () => {
    assert.deepEqual(classify(inChat({ text: 'Qaiser can you review the plan?', mentions: ['u-me'] }, 'group')), ['mentioned_me', 'response_needed']);
    assert.deepEqual(classify(inChat({ text: 'thanks Qaiser for the update', mentions: ['u-me'] }, 'group')), ['mentioned_me']);
  });

  test('group chatter not addressed to me is ignored', () => {
    assert.deepEqual(classify(inChat({ text: 'can someone grab lunch?' }, 'group')), []);
  });

  test('1:1 questions, approvals and decisions', () => {
    assert.deepEqual(classify(inChat({ text: 'got a minute?' })), ['direct_message', 'response_needed']);
    assert.deepEqual(classify(inChat({ text: 'need your go/no-go for the 8.886 release' })), ['approval_requested', 'direct_message', 'release_related']);
    assert.deepEqual(classify(inChat({ text: 'should we push the hotfix or wait, your call' })), ['decision_requested', 'direct_message', 'release_related', 'urgent']);
  });

  test('my later reply clears it; bots, system and deleted messages are ignored', () => {
    const q = inChat({ text: 'can you approve?', at: '2026-10-29T09:00:00Z' });
    const mine = inChat({ from: 'u-me', name: 'Qaiser', text: 'approved', at: '2026-10-29T09:05:00Z' });
    assert.deepEqual(classify(q, [q, mine]), ['direct_message']);
    assert.deepEqual(classify(inChat({ text: 'can you?', bot: true })), []);
    assert.deepEqual(classify(inChat({ text: 'can you?', type: 'systemEventMessage' })), []);
    assert.deepEqual(classify(inChat({ text: 'can you?', deleted: true })), []);
  });

  test('urgent release discussion is surfaced even if not addressed to me', () => {
    assert.deepEqual(classify(inChat({ text: 'Prod is down after the release, rolling back now' }, 'group', 'POS Eng')),
      ['release_related', 'urgent', 'urgent_discussion']);
  });

  test('my own commitments', () => {
    const r = classifyChatMessage(inChat({ from: 'u-me', name: 'Qaiser', text: "I'll send the release notes by tomorrow" }), [], me, ms, NOW);
    assert.deepEqual(r.signals, ['my_commitment']);
    assert.equal(r.dueDate, '2026-10-30');
  });
});

describe('teams sync', () => {
  let store, calls, chatList, chatMessages, channelPages;

  beforeEach(() => {
    store = createStore(openDb(':memory:'));
    calls = [];
    chatList = [];
    chatMessages = {};
    channelPages = [];
  });

  const graph = () => ({
    me: async () => ME,
    collect: async (url, opts = {}) => {
      calls.push({ url, query: opts.query });
      if (url === '/me/chats') {
        const items = [];
        for (const c of chatList) { if (opts.stopWhen?.(c)) break; items.push(c); }
        return { items };
      }
      const chat = url.match(/^\/me\/chats\/([^/]+)\/messages$/);
      if (chat) return { items: chatMessages[decodeURIComponent(chat[1])]?.shift() ?? [] };
      if (url === '/me/joinedTeams') return { items: [{ id: 'T', displayName: 'Restaurant Eng' }] };
      if (url === '/teams/T/channels') return { items: [{ id: 'C', displayName: 'Releases' }] };
      if (url.endsWith('/delta') || url.includes('channel-delta')) return { items: channelPages.shift() ?? [], deltaLink: 'https://graph.microsoft.com/v1.0/channel-delta?n=1' };
      if (url.endsWith('/replies')) return { items: [gmsg({ id: 'rep1', replyToId: 'root1', text: 'Qaiser, should we roll back?', mentions: ['u-me'] })] };
      throw new Error(`unexpected ${url}`);
    },
  });

  const chat = (id, last, chatType = 'oneOnOne', topic = null) => ({ id, chatType, topic, lastMessagePreview: { createdDateTime: last } });

  test('only chats active since the checkpoint are read, with per-chat filters', async () => {
    chatList = [chat('c1', '2026-10-29T10:00:00Z'), chat('c-old', '2026-09-01T00:00:00Z')];
    chatMessages.c1 = [[gmsg({ id: 'a', text: 'can you review?', at: '2026-10-29T10:00:00Z' })]];
    const r = await syncTeams({ graph: graph(), store, ms, now: NOW });
    assert.equal(r.chatsChecked, 1);
    assert.equal(r.newItems, 1);
    const msgCall = calls.find((c) => c.url.startsWith('/me/chats/c1/'));
    assert.match(msgCall.query.$filter, /^lastModifiedDateTime gt 2026-10-22/);

    // Second run: nothing new since checkpoint → no per-chat calls.
    chatList = [chat('c1', '2026-10-29T10:00:00Z')];
    calls = [];
    await syncTeams({ graph: graph(), store, ms, now: new Date('2026-10-29T15:30:00Z') });
    assert.deepEqual(calls.map((c) => c.url), ['/me/chats']);
  });

  test('a 1:1 request becomes a respond action linked to the message; my reply resolves it', async () => {
    chatList = [chat('c1', '2026-10-29T10:00:00Z', 'oneOnOne')];
    chatMessages.c1 = [[gmsg({ id: 'q', text: 'can you send the release notes?', at: '2026-10-29T10:00:00Z' })]];
    await syncTeams({ graph: graph(), store, ms, now: NOW });
    syncActions(store);
    const [action] = store.listOpenActions();
    assert.equal(action.type, 'respond');
    assert.match(action.title, /Reply to Alice in chat/);
    assert.match(store.listActionSources(action.id)[0].url, /teams\.microsoft\.com\/l\/message\/c1\/q/);

    // I reply after that sync ran.
    chatList = [chat('c1', '2026-10-29T15:20:00Z', 'oneOnOne')];
    chatMessages.c1 = [[gmsg({ id: 'mine', from: 'u-me', name: 'Qaiser', text: 'sent!', at: '2026-10-29T15:20:00Z' })]];
    await syncTeams({ graph: graph(), store, ms, now: new Date('2026-10-29T15:30:00Z') });
    assert.equal(syncActions(store).resolved, 1);
    assert.equal(store.listOpenActions().length, 0);
  });

  test('configured channels use delta and pull replies of changed threads', async () => {
    channelPages.push([gmsg({ id: 'root1', text: 'Release 8.886 status thread', at: '2026-10-29T08:00:00Z' })]);
    const r = await syncTeams({ graph: graph(), store, ms: { ...ms, teamsChannels: ['Restaurant Eng/Releases'] }, now: NOW });
    assert.equal(r.newItems, 2);
    const o = teamsOverview(store);
    assert.equal(o.decisionRequested.length, 1);
    assert.equal(o.decisionRequested[0].where, 'Restaurant Eng / Releases');
    assert.ok(calls.some((c) => c.url === '/teams/T/channels/C/messages/delta'));
  });
});

describe('cross-source dedupe', () => {
  test('email and Teams messages about the same Jira issue merge into one action', async () => {
    const store = createStore(openDb(':memory:'));
    store.upsertItem({ source: 'jira', externalId: '1', kind: 'issue', title: 'REST-21533: EzCater save fails', project: 'REST',
      data: { key: 'REST-21533', summary: 'EzCater save fails', project: 'REST', tracked: true, signals: [], recentComments: [], blockedBy: [] } });
    const msgData = (extra) => ({ signals: ['response_needed'], jiraKeys: ['REST-21533'], from: { name: 'Alice' }, ...extra });
    const email = store.upsertItem({ source: 'outlook', externalId: 'e1', kind: 'email', title: 'REST-21533 status', url: 'https://outlook/e1',
      threadKey: 'conv1', occurredAt: '2026-10-29T09:00:00Z', data: msgData({ subject: 'REST-21533 status', preview: 'Can you give an update on REST-21533?' }) });
    const chatMsg = store.upsertItem({ source: 'teams', externalId: 't1', kind: 'chat_message', title: 'x', url: 'https://teams/t1',
      threadKey: 'chat:c1', occurredAt: '2026-10-29T10:00:00Z', data: msgData({ text: 'any news on REST-21533?', chatType: 'oneOnOne' }) });

    syncActions(store);
    const open = store.listOpenActions();
    assert.equal(open.length, 1, 'one action for one underlying issue');
    assert.equal(open[0].dedupe_key, 'jira:REST-21533:respond');
    assert.equal(open[0].project, 'REST');
    const sources = store.listActionSources(open[0].id).map((s) => s.id).sort();
    assert.deepEqual(sources, [email.id, chatMsg.id].sort());
  });
});
