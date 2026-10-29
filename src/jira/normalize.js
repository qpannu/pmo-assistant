// Turns raw Jira API payloads into the small records we store. Only fields the
// assistant uses are kept, and volatile ones (like `updated`) are kept out of
// the stored data so they don't make an unchanged issue look changed.

export const ISSUE_FIELDS = [
  'summary', 'status', 'priority', 'issuetype', 'assignee', 'reporter', 'duedate',
  'fixVersions', 'labels', 'project', 'created', 'updated', 'resolutiondate', 'issuelinks', 'comment',
];

const KEEP_COMMENTS = 3;
const COMMENT_CHARS = 500;

// Atlassian Document Format → plain text plus the account ids it @mentions.
export function adfToText(node) {
  const mentions = new Set();
  const walk = (n) => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'mention') {
      if (n.attrs?.id) mentions.add(n.attrs.id);
      return n.attrs?.text ?? '@mention';
    }
    if (n.type === 'hardBreak') return '\n';
    const inner = (n.content ?? []).map(walk).join('');
    return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type) ? inner + '\n' : inner;
  };
  const text = walk(node).replace(/\n{3,}/g, '\n\n').trim();
  return { text, mentions: [...mentions] };
}

const person = (u) => (u ? { accountId: u.accountId, name: u.displayName } : null);

export function normalizeIssue(issue) {
  const f = issue.fields ?? {};
  const comments = f.comment?.comments ?? [];

  return {
    key: issue.key,
    summary: f.summary ?? '',
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null, // 'new' | 'indeterminate' | 'done'
    priority: f.priority?.name ?? null,
    project: f.project?.key ?? null,
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    dueDate: f.duedate ?? null,
    created: f.created ?? null,
    resolved: f.resolutiondate ?? null,
    labels: [...(f.labels ?? [])].sort(),
    fixVersions: (f.fixVersions ?? []).map((v) => ({
      id: v.id, name: v.name, releaseDate: v.releaseDate ?? null, released: Boolean(v.released),
    })),
    blockedBy: (f.issuelinks ?? [])
      .filter((l) => l.inwardIssue && /is blocked by/i.test(l.type?.inward ?? ''))
      .map((l) => ({
        key: l.inwardIssue.key,
        status: l.inwardIssue.fields?.status?.name ?? null,
        done: l.inwardIssue.fields?.status?.statusCategory?.key === 'done',
      })),
    commentCount: f.comment?.total ?? comments.length,
    recentComments: comments.slice(-KEEP_COMMENTS).map((c) => {
      const { text, mentions } = adfToText(c.body);
      return {
        id: c.id,
        author: person(c.author),
        created: c.created,
        text: text.length > COMMENT_CHARS ? text.slice(0, COMMENT_CHARS) + '…' : text,
        mentions,
      };
    }),
  };
}

export function normalizeVersion(v, projectKey) {
  return {
    id: v.id,
    name: v.name,
    project: projectKey,
    releaseDate: v.releaseDate ?? null,
    released: Boolean(v.released),
    archived: Boolean(v.archived),
  };
}
