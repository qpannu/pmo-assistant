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

### Jira efficiency

- First run and every `JIRA_FULL_SYNC_HOURS` (default 24): full fetch of open relevant issues.
- In between: only issues updated since the last sync (+2 min overlap).
- Only the fields used are requested; the last 3 comments are kept per issue.
- Stored content is hashed; an issue whose relevant fields didn't change is not marked for
  re-analysis, even if Jira's `updated` timestamp moved.
- Syncs never overlap; failures are logged and recorded without losing the sync position.

## Outlook and Teams (read-only, Microsoft Graph)

### 1. Register an app in Microsoft Entra ID (one time, free)

1. Open <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
   - Name: `PMO Assistant (local)`
   - Supported account types: **Accounts in this organizational directory only** (single tenant)
   - Redirect URI: leave empty → **Register**
2. On the app's **Overview** page, copy **Application (client) ID** and **Directory (tenant) ID**
   into your local `.env` as `MS_CLIENT_ID` and `MS_TENANT_ID`. These are identifiers, not secrets.
3. **Authentication → Advanced settings → Allow public client flows → Yes → Save.**
   (Needed for the device-code sign-in. Do **not** create a client secret; none is used.)
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:

   | Permission | Why | Admin consent |
   |---|---|---|
   | `User.Read` | Your name and email address | No |
   | `offline_access` | Stay signed in (refresh token) | No |
   | `Mail.Read` | Read your mailbox (Inbox, Sent Items) | No* |
   | `Chat.Read` | Read your 1:1, group and meeting chats | No* |

   Only if you set `MS_TEAMS_CHANNELS` (watch specific channels):

   | Permission | Why | Admin consent |
   |---|---|---|
   | `Team.ReadBasic.All`, `Channel.ReadBasic.All` | Find the teams/channels by name | No* |
   | `ChannelMessage.Read.All` | Read messages in those channels | **Yes** |

   \*Your organisation may still require an admin to approve. If sign-in says
   "Need admin approval", ask IT to **Grant admin consent** on this app's API permissions page.

   No `Mail.Send`, `Chat.ReadWrite` or other write permission is requested: the assistant cannot
   send email or Teams messages.

### 2. Sign in

```bash
npm run ms:login
```

It prints a code; open <https://microsoft.com/devicelogin>, enter it and sign in with your
work account. Your password goes only to Microsoft. The resulting token is saved to
`data/.ms-token.json` (git-ignored, readable only by you). Restart the server afterwards.

### 3. Test each integration

```bash
npm run test:outlook   # profile, inbox delta query, sent items (read-only)
npm run test:teams     # recent chats, incremental message query, configured channels
```

Then with the server running:

```bash
curl -X POST http://127.0.0.1:3100/outlook/sync && curl http://127.0.0.1:3100/outlook/overview
curl -X POST http://127.0.0.1:3100/teams/sync   && curl http://127.0.0.1:3100/teams/overview
curl http://127.0.0.1:3100/actions
```

### What counts as needing you

**Email** — unread alone never does. A message needs you when it is from a person (not a
notification, newsletter or Focused-Inbox "Other"), addressed to you (in To with ≤10 recipients,
or names you), recent (`MS_REPLY_WINDOW_DAYS`), asks a question / request / approval /
decision, and you haven't replied in that conversation since. Flagged emails are follow-ups.
From your Sent Items: promises you made ("I'll send…") and questions nobody answered after
`MS_FOLLOWUP_AFTER_DAYS`. Deadlines like "by Friday" or "EOD" set the due date.

**Teams** — @mentions, 1:1 messages and messages naming you that ask, request or need a
decision, unless you replied later in that chat/thread. Urgent project or release discussions
(e.g. "prod is down after the release") are surfaced even when not addressed to you.

**Incremental:** Outlook uses Graph delta queries (Inbox and Sent Items). Teams lists chats by
latest activity and only reads chats active since the last check, fetching messages modified
since each chat's cursor; channels use delta queries. Metered/paid Graph APIs are not used.

## Action items

Findings from Jira, Outlook and Teams become action items (`respond`, `decide`, `prioritize`,
`follow_up`, `review`) with priority 1–4 and due dates.

- **Deduplicated:** an email and a Teams message about `REST-21533` and the Jira issue itself
  produce one action, with all three linked as sources. Otherwise one action per email
  conversation or chat thread.
- **Self-resolving:** when you reply (or the Jira condition clears) the action closes
  automatically and reopens if a new request arrives. Items you close or dismiss stay closed.

```bash
curl http://127.0.0.1:3100/actions
curl -X POST -H 'Content-Type: application/json' -d '{"status":"done"}' http://127.0.0.1:3100/actions/12/status
```

Statuses: `open`, `done`, `dismissed`, `snoozed` (with `"snoozedUntil": "2026-11-03"`). Changing a
status only updates the local database.

## Priority engine

One ranked list across Jira, Outlook and Teams, recomputed after every sync.

```bash
npm run demo:priorities                              # fictional sample data, in memory
curl 'http://127.0.0.1:3100/priorities?format=text'  # your real list (no alerts raised)
curl -X POST http://127.0.0.1:3100/priorities/run    # rank and record new critical alerts
curl http://127.0.0.1:3100/alerts                    # unacknowledged alerts
```

The report has five parts: **critical actions**, **decisions & responses waiting for you**,
**upcoming release risks**, **follow-ups & overdue commitments**, and a **recommended top three**.
Every item lists its source (with a link), the evidence quoted from it, why it scored as it did,
and a recommended next action.

**Scoring (ordinary code, no AI).** Points for: production blockers (+40); releases at critical
or warning risk (+45 / +25), and issues inside them (+25 / +12); blockers and dependencies (+10–12);
urgent wording (+25); business impact words such as merchants, payments, outage (+8); decisions
(+18) and replies (+15) waiting on you, growing with each day waited; overdue items (+20–40;
more than 60 days overdue is treated as probably stale, +5); items raised in more than one system (+8);
plus the action's base priority. Score ≥ 70, a production blocker, or a critical release makes an
item critical.

**State between runs.** Rankings are stored on each action item and rewritten only when they change.
Items you mark done, dismissed or snoozed stay that way across syncs. Each critical item raises an
alert once; re-runs don't repeat it.

**Claude (optional, billed).** With `PRIORITY_USE_CLAUDE=true` and `ANTHROPIC_API_KEY` set, Claude
(`CLAUDE_MODEL`, default `claude-opus-5-5`) picks and explains the top three from the eight
highest-scored items. It is called only when those candidates change, the answer is cached, and
any failure falls back to the rule-based top three. Notifications (desktop/email/Teams) are not
connected yet.
