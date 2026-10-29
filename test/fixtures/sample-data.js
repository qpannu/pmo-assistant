// Fictional sample data across Jira, Outlook and Teams, shaped exactly as the
// sync modules store it (normalised data + rule signals). Used by the priority
// engine tests and `npm run demo:priorities`.

import { syncActions } from '../../src/actions.js';

const ago = (now, days, hours = 0) => new Date(now - days * 86_400_000 - hours * 3_600_000).toISOString();
const ymd = (now, days) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
const person = (name) => ({ accountId: `acc-${name.toLowerCase()}`, name });
const ME = person('Me');

function jiraIssue(store, now, { id, key, summary, type = 'Story', status = 'Open', priority = 'Medium', assignee = null,
  dueDate = null, signals = [], fixVersions = [], blockedBy = [], comments = [], updatedDaysAgo = 1 }) {
  return store.upsertItem({
    source: 'jira', externalId: id, kind: 'issue', title: `${key}: ${summary}`,
    url: `https://example.atlassian.net/browse/${key}`, author: 'Reporter', project: key.split('-')[0],
    occurredAt: ago(now, updatedDaysAgo),
    data: {
      key, summary, type, status, statusCategory: 'indeterminate', priority, project: key.split('-')[0],
      assignee, reporter: person('Reporter'), dueDate, created: ago(now, 30), resolved: null, labels: [],
      fixVersions, blockedBy, commentCount: comments.length, recentComments: comments, signals, tracked: true,
    },
  });
}

function email(store, now, { id, conv, folder = 'inbox', from, to = ['me@example.com'], subject, preview, daysAgo, signals, dueDate = null, jiraKeys = [] }) {
  const at = ago(now, daysAgo);
  return store.upsertItem({
    source: 'outlook', externalId: id, kind: folder === 'sentitems' ? 'sent_email' : 'email', title: subject,
    url: `https://outlook.office365.com/owa/?ItemID=${id}`, author: from.name, occurredAt: at, threadKey: conv,
    data: {
      id, conversationId: conv, folder, subject, from, to, cc: [], toCount: to.length, ccCount: 0,
      receivedAt: at, sentAt: at, importance: 'normal', flagStatus: 'notFlagged', flagDue: null, focused: true,
      isMeetingMessage: false, isDraft: false, preview, webLink: `https://outlook.office365.com/owa/?ItemID=${id}`,
      jiraKeys, signals, dueDate,
    },
  });
}

function chat(store, now, { id, chatId, chatType = 'oneOnOne', chatTopic = null, from, text, hoursAgo, signals, jiraKeys = [] }) {
  const at = ago(now, 0, hoursAgo);
  return store.upsertItem({
    source: 'teams', externalId: id, kind: 'chat_message', title: text.slice(0, 120),
    url: `https://teams.microsoft.com/l/message/${chatId}/${id}`, author: from, occurredAt: at, threadKey: `chat:${chatId}`,
    data: {
      id, chatId, chatType, chatTopic, channel: null, replyToId: null, threadKey: `chat:${chatId}`,
      from: { id: `u-${from.toLowerCase()}`, name: from, isBot: false }, createdAt: at, deleted: false, isSystem: false,
      importance: 'normal', subject: null, text, mentionIds: [], webUrl: `https://teams.microsoft.com/l/message/${chatId}/${id}`,
      jiraKeys, signals, dueDate: null,
    },
  });
}

export function seedSample(store, now = new Date()) {
  const release = { id: '500', name: 'POS 8.9.1', releaseDate: ymd(now, -3) };

  // Jira
  jiraIssue(store, now, {
    id: '1', key: 'REST-900', summary: 'Online orders fail to reach the kitchen display', type: 'Bug', status: 'Dev in Progress',
    priority: 'High', assignee: person('Ben'), signals: ['production_blocker'], fixVersions: [release],
  });
  jiraIssue(store, now, {
    id: '2', key: 'REST-901', summary: 'Tip report totals wrong after refund', status: 'Blocked', assignee: ME,
    signals: ['assigned_to_me', 'blocked'], fixVersions: [release], blockedBy: [{ key: 'PAY-77', status: 'Open', done: false }],
  });
  jiraIssue(store, now, {
    id: '3', key: 'REST-902', summary: 'Go/No-Go checklist for kiosk rollout', assignee: ME, dueDate: ymd(now, -10),
    signals: ['assigned_to_me', 'overdue'], updatedDaysAgo: 12,
  });
  jiraIssue(store, now, {
    id: '4', key: 'REST-903', summary: 'Clarify scope of loyalty export', assignee: person('Sam'),
    signals: ['awaiting_my_reply'],
    comments: [{ id: 'c1', author: person('Sam'), created: ago(now, 1), text: '@Me should the export include inactive members?', mentions: [ME.accountId] }],
  });
  store.upsertItem({
    source: 'jira', externalId: `version:${release.id}`, kind: 'release', title: `REST ${release.name}`,
    url: 'https://example.atlassian.net/projects/REST/versions/500', project: 'REST', occurredAt: release.releaseDate,
    data: {
      ...release, project: 'REST', released: false, archived: false, risk: 'critical', daysLeft: -3, openIssues: 2,
      blockedIssues: ['REST-901'], productionBlockers: ['REST-900'], highPriorityOpen: 1, tracked: true,
      reasons: ['release date passed 3 day(s) ago with 2 open issue(s): REST-900, REST-901', '1 blocked issue(s): REST-901'],
    },
  });

  // Outlook
  email(store, now, {
    id: 'e1', conv: 'conv-gonogo', from: { name: 'Randy', address: 'randy@example.com' },
    subject: 'POS 7.45.0.29 hotfix — Go/No-Go', preview: 'QA signed off. Need your approval to deploy the hotfix tonight.',
    daysAgo: 2, signals: ['approval_requested', 'release_related'],
  });
  email(store, now, {
    id: 'e2', conv: 'conv-merchant', from: { name: 'Alicia', address: 'alicia@example.com' },
    subject: 'Merchants impacted by REST-900', preview: 'Three merchants report missing kitchen tickets. Can you give us an ETA for REST-900?',
    daysAgo: 0, signals: ['response_needed', 'urgent'], jiraKeys: ['REST-900'],
  });
  email(store, now, {
    id: 's1', conv: 'conv-cakepop', folder: 'sentitems', from: { name: 'Me', address: 'me@example.com' }, to: ['randy@example.com'],
    subject: 'Re: CakePOP 1.21.5 Go/No-Go', preview: 'I will send the approval email once KDS validation is complete, by Friday.',
    daysAgo: 4, signals: ['my_commitment'], dueDate: ymd(now, -1),
  });
  email(store, now, {
    id: 's2', conv: 'conv-dd', folder: 'sentitems', from: { name: 'Me', address: 'me@example.com' }, to: ['partner-support@example.com'],
    subject: 'Dev portal access', preview: 'Can you confirm when developer accounts will be re-enabled?',
    daysAgo: 5, signals: ['awaiting_their_reply'],
  });

  // Teams
  chat(store, now, {
    id: 't1', chatId: 'chat-ops', chatType: 'group', chatTopic: 'Merchant Ops', from: 'Debbie',
    text: 'Any update on REST-900? Orders are still failing for the pilot merchants.', hoursAgo: 2,
    signals: ['mentioned_me', 'response_needed', 'urgent'], jiraKeys: ['REST-900'],
  });
  chat(store, now, {
    id: 't2', chatId: 'chat-jacob', from: 'Jacob', text: 'Can I get a plan for how the kiosk improvements will be deployed? Product is asking.',
    hoursAgo: 3, signals: ['direct_message', 'release_related', 'response_needed'],
  });
  chat(store, now, {
    id: 't3', chatId: 'chat-rob', from: 'Rob', text: 'When is the target deployment for the re-order button?',
    hoursAgo: 1, signals: ['direct_message', 'release_related', 'response_needed'],
  });

  return syncActions(store);
}
