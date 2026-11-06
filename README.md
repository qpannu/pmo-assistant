# PMO Assistant

A lightweight PMO assistant that tracks your priorities across Jira, Outlook and Teams,
ranks them, and sends you a morning briefing, urgent alerts, a midday update and an
end-of-day summary in Microsoft Teams. It runs on your machine (`127.0.0.1`) and keeps
its data in one local SQLite file.

**What it will never do:** send an email or Teams message to anyone (drafts wait for
you to approve and send them yourself), or change Jira tickets, priorities, assignments
or release dates. All integrations are read-only; the only outgoing message is the
notification to *you* through your own Teams webhook.

## Quick start

```bash
nvm use                  # Node 24 (from .nvmrc)
npm install
cp .env.example .env     # then fill it in locally — never commit it or paste values into chat
npm test                 # 100+ tests, no network
npm run demo:priorities  # see a ranked report on fictional data
npm start                # http://127.0.0.1:3100
```

Minimum to be useful: Jira settings (below). Add the Teams webhook to get notifications,
Claude for written briefings/answers/drafts, and Microsoft sign-in for Outlook/Teams data.
Each piece is optional and the service runs without the others.

## How it works

```
Jira ─┐                                          ┌─ Teams notifications to you
Outlook ─┼─ read-only sync (incremental) ─ SQLite ─ rules: signals → action items → scores ─┤  (briefings, urgent alerts)
Teams ─┘                                          └─ Claude only for writing: briefings,
                                                     risk analysis, answers, drafts
```

1. **Sync** every few minutes: only new or changed records are fetched.
2. **Rules** flag what needs you, merge duplicates across systems, and score every item.
3. **Alerts**: a newly critical item sends one Teams alert (never repeated).
4. **Briefings** at 08:00, 12:30 and 17:30 on weekdays (configurable).
5. **Claude** writes briefings, answers and drafts from a short, pre-ranked context.

## Daily use

| You want to… | Do this |
|---|---|
| See today's priorities | `curl 'http://127.0.0.1:3100/priorities?format=text'` |
| Ask a question | `curl -X POST -H 'Content-Type: application/json' -d '{"question":"What is blocking CCL_8.886.22.10?"}' http://127.0.0.1:3100/ask` |
| Send a briefing now | `curl -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3100/briefings/morning/run` (`midday`, `eod`; add `"force":true` to resend) |
| Draft a reply to an item | `curl -X POST -H 'Content-Type: application/json' -d '{"channel":"email","guidance":"approve, ask who owns rollback"}' http://127.0.0.1:3100/actions/12/draft` |
| Review drafts | `curl http://127.0.0.1:3100/drafts` · edit: `PATCH /drafts/:id` · `POST /drafts/:id/approve` or `/reject` |
| Send an approved draft | Use the copy-ready text or the Outlook/Teams link from `approve`, send it yourself, then `POST /drafts/:id/sent` |
| Close / snooze an item | `curl -X POST -H 'Content-Type: application/json' -d '{"status":"done"}' http://127.0.0.1:3100/actions/12/status` |
| Check the service | `curl http://127.0.0.1:3100/status` |

POST/PATCH calls must send JSON (`-H 'Content-Type: application/json'`), which stops web
pages from triggering them from your browser.

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

## Jira reports (scrum, releases, features, production)

Four independent reports, each run on its own. Facts (counts, statuses, dates) are computed
from Jira; health, risks and follow-ups are rule-based inferences and are labelled as such.
Nothing changes Jira.

```bash
npm run report -- scrum        # active sprint(s) on JIRA_BOARD_ID named REPORT_SPRINT_PREFIX…
npm run report -- releases     # unreleased Fix Versions starting with REPORT_RELEASE_PREFIXES
npm run report -- features     # tracked initiatives: health, dev/QA progress, estimated finish
npm run report -- prod         # REPORT_PROD_ISSUE_TYPE in REPORT_PROD_PROJECT for REPORT_PROD_TEAM
```

Add `--json` for structured output or `--no-save` to skip the snapshot. Over HTTP:
`GET /reports/<name>` (`?format=md` for text).

- **Scrum:** phases follow the board's columns; progress by issues and story points, by component;
  blockers (status, flag, "is blocked by"), dependencies, carry-over, at-risk items.
- **Releases:** progress per version (merged by name across projects), target-date status,
  bugs, blocked work, work outside the active sprint; finished-but-unreleased and dormant versions.
- **Features:** Initiative → Epics → issues via `parent`. Dev progress (Open … Building = not
  dev-complete), QA progress (Ready for QA / QA in Progress; anything later = QA done); Blocked and
  On Hold are placed by who moved them there (change log vs Assigned Developer / Assigned QA).
  Weighted by DEV/QA Hours when most tickets have them; estimated finish from remaining hours per
  person at `REPORT_DEV_HOURS_PER_DAY` / `REPORT_QA_HOURS_PER_DAY`.
- **Production:** the Team dropdown is matched and re-checked per issue; open issues split into
  "with engineering" and "waiting" (`REPORT_PROD_WAITING_STATUSES`), severity, age, stalled,
  blocked, ownership, recently resolved.

**Tracked features** (no code changes needed; history is kept when you remove one):

```bash
npm run features -- list
npm run features -- add REST-12345 "note"
npm run features -- remove REST-12345
```

**Learning from history and your feedback.** Each follow-up shows a short ref. Mark it:

```bash
npm run risk -- list
npm run risk -- a1b2c3 dismissed "known, vendor fix due Friday"
```

`valid` ranks it higher; `dismissed` hides it until its facts change in Jira; `resolved` keeps it
visible with a note if Jira still shows it; `clear` forgets the verdict. Rule types you mostly
dismiss rank lower; unchanged repeats collapse into one line (urgent ones always show); recurring
blockers and reopened production issues are found from past snapshots. Weights and on/off
switches live in `report-rules.json` (copy `report-rules.example.json`). This is counting and
rules, not model training, and it never overrides Jira data.

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

## Teams notifications (to you)

Uses a **Teams Workflow webhook** — no Entra app registration needed.

1. In Teams, open **Workflows** (Apps → Workflows) → **Create** → template
   **"Send webhook alerts to a chat"** (or "Post to a chat when a webhook request is received").
2. Choose **Post as: Flow bot** and **Post in: Chat with Flow bot** (a private chat with you),
   then **Save**. Copy the **HTTP POST URL** it shows.
3. Put it in `.env` as `TEAMS_WEBHOOK_URL=...` and restart. Treat it like a password: anyone
   with the URL can post to that chat.

Without the URL, notifications are written to the log instead (dry run) and `/status`
shows `teamsConfigured: false`.

| Notification | When | Content |
|---|---|---|
| 🔴 Urgent alert | After a sync finds a new critical item | The item, the next step, and buttons to open the source |
| ☀️ Morning briefing | `BRIEFING_MORNING` (08:00) | Top 3, cross-project risks, waiting on you, what's new |
| 🕛 Midday update | `BRIEFING_MIDDAY` (12:30) | Only what changed since the morning |
| 🌙 End-of-day summary | `BRIEFING_EOD` (17:30) | Closed today, still open for tomorrow, due tomorrow |
| ⚠️ Service alert | A sync fails for ~3 intervals | Which source and the last error (once per day) |

Briefings go out once per day each, on `BRIEFING_DAYS` (weekdays). If the service starts late,
it catches up within 3 hours. A failed delivery is retried with the same text.

## Claude (optional, billed per call)

Set `CLAUDE_ENABLED=true` and `ANTHROPIC_API_KEY` (from <https://console.anthropic.com>). Model:
`CLAUDE_MODEL` (default `claude-opus-5-5`). Without Claude everything still works with
plain rule-based text.

Claude is called only for:

| Use | Calls | Effort |
|---|---|---|
| Morning briefing incl. cross-project risk analysis | 1/day | medium |
| Midday update | 0–1/day (0 if nothing changed since morning) | low |
| End-of-day summary | 1/day | low |
| `/ask` question | 1 per question | low |
| Draft | 1 per draft | low |

How calls and tokens stay low:
- Claude never reads raw mailboxes or Jira: it gets at most ~12 pre-ranked items with
  one-line reasons, evidence snippets and next steps, plus computed per-project and
  release roll-ups.
- Midday and end-of-day briefings send only changes; an unchanged midday skips Claude.
- Questions send only the records that match the question (Jira keys and keywords).
- `CLAUDE_DAILY_CALL_LIMIT` (default 40) is a hard cap; beyond it the assistant uses rules.
- Instructions come first with a prompt-cache breakpoint. Put background about your projects
  and team in a text file and set `PMO_CONTEXT_FILE`: it's sent with each call and cached.
  (Prompts shorter than the model's minimum cacheable size simply aren't cached.)
- Every call is logged with its token usage; see `claude.today` in `/status`.

Typical day: 3–8 calls. Check `/status` for actual token use.

## Monitoring and errors

- `GET /health` — process and database.
- `GET /status` — `ok` or `degraded` with reasons: per-source last sync and last error,
  stale syncs, today's briefings and how they were produced, alerts waiting for delivery,
  drafts awaiting review, Claude calls and tokens today.
- Logs are JSON lines on stdout/stderr; secrets (tokens, keys, webhook URL) are redacted.
- Every external call has timeouts and retries (Jira, Graph, Teams webhook). Failures are
  recorded and retried on the next run without losing the sync position.
- If Claude is off, over its limit, refuses or fails, the rule-based version is used.

## Running it every day (macOS)

The service only needs to run while you work. Simplest: keep a terminal open with
`nvm use && npm start`. To start it automatically at login, use a LaunchAgent that runs
`npm start` in this folder with Node 24 on the PATH. Its data stays in `data/`; back that
folder up if you want to keep history.

Before relying on it daily:
1. `npm test` passes.
2. `npm run test:jira` passes (and `test:outlook` / `test:teams` once signed in).
3. Set `TEAMS_WEBHOOK_URL`, then `POST /briefings/morning/run` with `{"force":true}` and confirm
   the card arrives in Teams.
4. If using Claude: set the key, send one morning briefing, and check `claude.today` in `/status`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node: bad option: --env-file-if-exists` | Run `nvm use` (Node 24) |
| `EADDRINUSE` on start | Another instance is running; stop it or change `PORT` |
| No Teams messages | `/status` → `teamsConfigured`; check the log for "dry run" or webhook HTTP errors |
| Briefing text is plain lists | Claude is off, over `CLAUDE_DAILY_CALL_LIMIT`, or failed — see `briefingsToday[].method` |
| `jira sync failed … 401` | Regenerate `JIRA_API_TOKEN` |
| Outlook/Teams "sign-in required" | `npm run ms:login`, then restart |

## 7:00 AM briefing and two-way Teams chat

### What you get

- **Weekday briefing at 7:00 AM America/New_York** (daylight saving handled), in your personal
  Teams chat: today's priorities, meetings, pending on you, production issues, releases (with
  scope changes), ezCater, overdue items and a recommended focus. Every section either has
  verified data with links or says what's missing. Unchanged low-priority items aren't repeated.
- **Chat with the assistant in Teams.** Ask anything ("What should I focus on today?", "What is
  blocking the next POS release?", "Summarize the latest ezCater progress", "Draft a response to
  my manager about the release date"). It syncs Jira first if data is older than 10 minutes,
  remembers the last few exchanges for follow-ups, and returns drafts for review —
  `approve draft 7` gives you send links; it never sends anything for you.

### How it works (and why no extra infrastructure)

| Piece | Mechanism | Needs |
|---|---|---|
| Briefing delivery | Teams Workflow webhook → your private chat with the Workflows bot | `TEAMS_WEBHOOK_URL` |
| Calendar section | Graph `GET /me/calendarView`, or else your published Outlook calendar (ICS) | Entra app + **Calendars.Read**, or `OUTLOOK_ICS_URL` (no IT) |
| Receiving your chat messages | Graph polls one chat every 20 s (`GET /chats/{id}/messages`) | Entra app + **Chat.Read** |
| Replies (default) | Same Workflow webhook → same Workflows chat | nothing extra |
| Replies (alternative) | Graph `POST /chats/{id}/messages`, only to `TEAMS_CHAT_ID` | **ChatMessage.Send** |

Graph access alone does not let a service *receive* Teams messages: Microsoft's push options
(bots, change notifications) need a public HTTPS endpoint and an Azure Bot registration. Polling
one chat with delegated `Chat.Read` avoids both, runs on your Mac, and costs nothing.

### Setup

1. **Teams webhook** (no IT needed): Teams → Workflows → "Send webhook alerts to a chat" →
   post as Flow bot in your chat with Flow bot → copy the URL into `TEAMS_WEBHOOK_URL`.
2. **Calendar without IT:** Outlook on the web → Settings → Calendar → Shared calendars →
   Publish a calendar → your calendar, *Can view all details* → Publish → copy the **ICS** link
   into `OUTLOOK_ICS_URL` in `.env`. Recurring meetings, moved/cancelled occurrences, time zones
   and all-day PTO are handled; the feed is fetched at most every 10 minutes. Revoke it any time
   with *Reset links* on the same page.
3. **Entra app (IT):** add delegated **Calendars.Read** to the permissions listed above
   (User.Read, offline_access, Mail.Read, Chat.Read). Add **ChatMessage.Send** only if you want
   reply mode `graph`. Put `MS_TENANT_ID` / `MS_CLIENT_ID` in `.env`, then `npm run ms:login`.
4. **Pick the chat:** type `hello` in your Workflows bot chat, then
   `npm run chat:setup` (lists chats) and `npm run chat:setup -- <chatId>` (confirms your
   message is visible). Set `TEAMS_CHAT_ID`.
   If Teams doesn't let you type in the Workflows chat, use your "notes to self" chat (or any
   chat only you use) with `TEAMS_CHAT_REPLY_MODE=graph`.
4. Optional: `MY_MANAGER_NAME`/`MY_MANAGER_EMAIL`, extra `PMO_SCOPES` (e.g. Team Tesla JQL).
5. **Run it in the background:** stop any `npm start` terminal, then `npm run service:install`.
   It starts at login, restarts on crash, logs to `logs/`, and runs without Claude Code.
   After editing `.env`: `npm run service:restart`.

### Test

```bash
npm test                                   # includes DST, duplicates, chat, recovery tests
curl -X POST -H 'Content-Type: application/json' -d '{"force":true}' http://127.0.0.1:3100/briefings/morning/run
```
Then send "What should I focus on today?" in the chat and expect a reply within ~20 seconds.

### Reliability

- **No duplicate briefings:** each day's briefing is claimed in the database before sending, so
  restarts or two running copies can't both send it.
- **Missed runs:** if the Mac was asleep at 7:00, the briefing goes out when it wakes, up to
  `BRIEFING_GRACE_MINUTES` (4 h) late; after that it's logged as missed. To be safe, let the Mac
  wake itself (System Settings → Battery/Energy → schedule) or keep it on power.
- **Failures:** a failed delivery is retried with the same text; chat replies are retried on the
  next poll (3 attempts); expired Microsoft sign-in pauses chat with one Teams alert per day and
  resumes automatically after `npm run ms:login`.
- **Cost control:** one Claude call per briefing and per chat question (drafts: one), within
  `CLAUDE_DAILY_CALL_LIMIT`; URLs are sent to Claude as short ids; without Claude everything falls
  back to rule-based text.
# pmo-assistant
