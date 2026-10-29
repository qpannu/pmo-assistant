// Live, read-only check against your Jira site. Skipped unless Jira credentials
// are set. Run with: npm run test:jira   (loads .env; writes nothing anywhere)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, integrationStatus } from '../src/config.js';
import { createJiraClient } from '../src/jira/client.js';
import { ISSUE_FIELDS, normalizeIssue } from '../src/jira/normalize.js';
import { buildRelevanceJql } from '../src/jira/sync.js';

const config = loadConfig();
const skip = integrationStatus(config).jira ? false : 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN not set';

test('connects to Jira and reads a small sample of issues', { skip, timeout: 60_000 }, async (t) => {
  const client = createJiraClient(config.jira);

  const me = await client.myself();
  assert.ok(me.accountId, 'authenticated user has an accountId');
  t.diagnostic(`connected as ${me.displayName}`);

  const { issues } = await client.search({
    jql: 'assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC',
    fields: ISSUE_FIELDS,
    limit: 5,
  });
  t.diagnostic(`sample: ${issues.length} issue(s)`);
  for (const raw of issues) {
    const issue = normalizeIssue(raw);
    assert.ok(issue.key && issue.status, 'issue normalises');
    t.diagnostic(`  ${issue.key} [${issue.status}] ${issue.priority ?? ''} ${issue.summary.slice(0, 60)}`);
  }
});

test('configured relevance query and projects are valid', { skip, timeout: 60_000 }, async (t) => {
  const client = createJiraClient(config.jira);
  // Jira answers anonymous searches with empty results, so authenticate first.
  await client.myself();

  // Validates the JQL built from your .env settings (project keys, types, priorities).
  const { issues } = await client.search({
    jql: `${buildRelevanceJql(config.jira)} AND statusCategory != Done ORDER BY updated DESC`,
    fields: ['summary'],
    limit: 1,
  });
  t.diagnostic(`relevance query OK (${issues.length ? 'has results' : 'no results'})`);

  for (const project of config.jira.projects) {
    const versions = await client.projectVersions(project);
    const upcoming = versions.filter((v) => !v.released && !v.archived && v.releaseDate);
    t.diagnostic(`${project}: ${upcoming.length} unreleased version(s) with a release date`);
  }
});
