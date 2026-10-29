# PMO Assistant

A lightweight, local, Claude-powered PMO assistant that tracks priorities across
Jira, Outlook and Teams. It runs on your machine (`127.0.0.1`), stores data in a
local SQLite file, and never sends messages or changes Jira without your approval.

## Setup

```bash
nvm use            # Node 24 (from .nvmrc)
npm install
cp .env.example .env
```

Fill in `.env` locally. Never commit it or paste its values into chat.

```bash
npm test           # unit tests (no network)
npm start          # http://127.0.0.1:3100
```

## Jira (read-only)

### Configure

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. In `.env` set:
   - `JIRA_BASE_URL` — your site, e.g. `https://yourco.atlassian.net`
   - `JIRA_EMAIL` — your Atlassian login email
   - `JIRA_API_TOKEN` — the token
   - `JIRA_PROJECTS` — project keys to watch for production bugs and releases, e.g. `OS,REST,UP`
3. Optional tuning (defaults in `.env.example`): which issue types/priorities count as
   production blockers and how recently they must have been updated
   (`JIRA_PROD_ACTIVE_DAYS`), how recent a mention must be to need a reply
   (`JIRA_REPLY_WINDOW_DAYS`), labels or statuses meaning "needs my decision", blocked
   statuses, how long watched issues stay relevant (`JIRA_WATCHER_ACTIVE_DAYS`), and the
   release window, including when an overdue version counts as abandoned
   (`JIRA_RELEASE_OVERDUE_DAYS`).

The integration only sends `GET` requests. Jira API tokens inherit your account's
permissions, so the read-only guarantee comes from the client code, which has no
write path.

### Test

```bash
npm run test:jira  # live, read-only: verifies the connection and prints a sample of issues
```

Then start the server and trigger a sync:

```bash
npm start
curl -X POST http://127.0.0.1:3100/jira/sync      # run a sync now (also runs every SYNC_INTERVAL_JIRA minutes)
curl http://127.0.0.1:3100/jira/overview          # what was found, from the local database
```

### What it tracks

Issues assigned to or reported by you (any project), issues you watch that were updated
recently, issues labelled for your decision, high-priority bugs in `JIRA_PROJECTS`, and
issues in releases due within the release window. Each issue gets rule-based signals:

| Signal | Meaning |
|---|---|
| `assigned_to_me` | Open and assigned to you |
| `overdue` / `due_soon` | Your issue (assignee or reporter) is past due / due within 3 days |
| `awaiting_my_decision` | Has a decision label or status |
| `awaiting_my_reply` | The latest comment @mentions you, isn't yours, and is recent |
| `production_blocker` | Open bug of a blocker priority, updated recently (optionally with a prod label) |
| `blocked` | Blocked status, or an open "is blocked by" link |

Upcoming and recently overdue releases get a risk level (`none` / `warning` / `critical`)
with reasons: overdue with open work, blocked issues, high-priority bugs, or open work
with ≤3 days left.

### Efficiency

- First run and every `JIRA_FULL_SYNC_HOURS` (default 24): full fetch of open relevant issues.
- In between: only issues updated since the last sync (+2 min overlap).
- Only the fields used are requested; the last 3 comments are kept per issue.
- Stored content is hashed; an issue whose relevant fields didn't change is not marked for
  re-analysis, even if Jira's `updated` timestamp moved.
- Syncs never overlap; failures are logged and recorded without losing the sync position.
