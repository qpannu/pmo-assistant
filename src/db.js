// SQLite via Node's built-in node:sqlite — no extra dependency, one local file.
// Schema changes are append-only migrations, applied in order on startup.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.js';

const MIGRATIONS = [
  // 1 — initial schema
  `
  -- Delta links / "updated since" cursors per source, so each sync only fetches changes.
  CREATE TABLE sync_state (
    source          TEXT PRIMARY KEY,           -- 'jira' | 'outlook' | 'teams' | ...
    cursor          TEXT,
    last_success_at TEXT,
    last_error      TEXT,
    updated_at      TEXT NOT NULL
  );

  -- Duplicate-event protection: an event is processed only if its id can be claimed here.
  CREATE TABLE processed_events (
    source      TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (source, event_id)
  );

  -- Normalised copy of each source record. content_hash vs analyzed_hash decides
  -- whether Claude needs to look at it again — unchanged items are never re-analysed.
  CREATE TABLE items (
    id            INTEGER PRIMARY KEY,
    source        TEXT NOT NULL,
    external_id   TEXT NOT NULL,
    kind          TEXT NOT NULL,                -- 'issue' | 'email' | 'chat_message' | ...
    title         TEXT,
    url           TEXT,
    author        TEXT,
    project       TEXT,
    occurred_at   TEXT,                         -- source timestamp (updated/received)
    data          TEXT NOT NULL,                -- JSON, trimmed to fields we use
    content_hash  TEXT NOT NULL,
    analyzed_hash TEXT,
    first_seen_at TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX items_pending_analysis ON items (source) WHERE analyzed_hash IS NOT content_hash;

  -- Things waiting on me. dedupe_key keeps re-analysis from creating duplicates.
  CREATE TABLE action_items (
    id            INTEGER PRIMARY KEY,
    dedupe_key    TEXT NOT NULL UNIQUE,
    item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
    type          TEXT NOT NULL CHECK (type IN ('respond','comment','decide','prioritize','follow_up','review','other')),
    title         TEXT NOT NULL,
    summary       TEXT,
    project       TEXT,
    priority      INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),  -- 1 = highest
    due_at        TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','done','dismissed')),
    snoozed_until TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    closed_at     TEXT
  );
  CREATE INDEX action_items_open ON action_items (status, priority, due_at);

  CREATE TABLE alerts (
    id              INTEGER PRIMARY KEY,
    dedupe_key      TEXT NOT NULL UNIQUE,
    item_id         INTEGER REFERENCES items(id) ON DELETE SET NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    title           TEXT NOT NULL,
    detail          TEXT,
    created_at      TEXT NOT NULL,
    acknowledged_at TEXT
  );

  -- Outgoing emails / Teams messages / Jira changes. Nothing is sent unless status = 'approved'.
  CREATE TABLE drafts (
    id             INTEGER PRIMARY KEY,
    action_item_id INTEGER REFERENCES action_items(id) ON DELETE SET NULL,
    channel        TEXT NOT NULL CHECK (channel IN ('email','teams','jira_comment','jira_update')),
    target         TEXT NOT NULL,               -- JSON: recipients / chat id / issue key
    subject        TEXT,
    body           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','sending','sent','failed')),
    error          TEXT,
    created_at     TEXT NOT NULL,
    decided_at     TEXT,
    sent_at        TEXT
  );

  -- Audit trail of everything the assistant did or the user decided.
  CREATE TABLE history (
    id          INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    event       TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX history_entity ON history (entity_type, entity_id);
  `,

  // 2 — threads, action-item sources, system vs user closure
  `
  -- Conversation / chat / thread an item belongs to (for "did I reply?" checks).
  ALTER TABLE items ADD COLUMN thread_key TEXT;
  CREATE INDEX items_thread ON items (source, thread_key);
  -- content_hash last turned into action items (independent of Claude's analyzed_hash).
  ALTER TABLE items ADD COLUMN actions_hash TEXT;

  -- 'user' when I closed it, 'auto' when the trigger went away (e.g. I replied).
  -- Only auto-closed items may reopen on a new trigger.
  ALTER TABLE action_items ADD COLUMN closed_reason TEXT;

  -- One action item can be backed by several source items (same issue across
  -- Jira, email and Teams); each link preserves the way back to the original.
  CREATE TABLE action_item_sources (
    action_item_id INTEGER NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
    item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    linked_at      TEXT NOT NULL,
    PRIMARY KEY (action_item_id, item_id)
  );
  CREATE INDEX action_item_sources_item ON action_item_sources (item_id);
  `,

  // 3 — priority engine ranking, kept between runs
  `
  ALTER TABLE action_items ADD COLUMN score INTEGER;
  ALTER TABLE action_items ADD COLUMN category TEXT;
  ALTER TABLE action_items ADD COLUMN score_reasons TEXT;   -- JSON [{points, label}]
  ALTER TABLE action_items ADD COLUMN ranked_at TEXT;
  ALTER TABLE alerts ADD COLUMN action_item_id INTEGER REFERENCES action_items(id) ON DELETE SET NULL;
  `,

  // 4 — notifications, briefings, Claude usage
  `
  ALTER TABLE alerts ADD COLUMN notified_at TEXT;
  ALTER TABLE alerts ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE alerts ADD COLUMN notify_error TEXT;

  -- One briefing per kind per day; input_hash lets unchanged updates skip Claude.
  CREATE TABLE briefings (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('morning','midday','eod')),
    day        TEXT NOT NULL,
    method     TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at    TEXT,
    send_error TEXT,
    UNIQUE (kind, day)
  );

  CREATE TABLE llm_calls (
    id                 INTEGER PRIMARY KEY,
    purpose            TEXT NOT NULL,
    model              TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    ms                 INTEGER,
    ok                 INTEGER NOT NULL,
    error              TEXT,
    created_at         TEXT NOT NULL
  );
  CREATE INDEX llm_calls_created ON llm_calls (created_at);
  `,

  // 5 — briefing snapshots (to skip unchanged items) and Teams chat history
  `
  ALTER TABLE briefings ADD COLUMN snapshot TEXT;   -- JSON: item ids/scores, release scopes

  CREATE TABLE chat_turns (
    id          INTEGER PRIMARY KEY,
    chat_id     TEXT NOT NULL,
    message_id  TEXT,
    role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX chat_turns_chat ON chat_turns (chat_id, created_at);
  `,

  // 6 — report snapshots (scrum, releases, features, prod), kept for comparisons
  `
  CREATE TABLE report_snapshots (
    id         INTEGER PRIMARY KEY,
    report     TEXT NOT NULL,       -- 'scrum' | 'releases' | 'features' | 'prod'
    scope      TEXT NOT NULL,       -- e.g. board id, or 'tesla'
    data       TEXT NOT NULL,       -- JSON: compact per-issue state for diffs
    hash       TEXT NOT NULL,
    taken_at   TEXT NOT NULL
  );
  CREATE INDEX report_snapshots_lookup ON report_snapshots (report, scope, taken_at);
  `,

  // 7 — features (initiatives) I track; removal is a soft delete so history stays
  `
  CREATE TABLE tracked_features (
    key         TEXT PRIMARY KEY,    -- Jira key, e.g. REST-247
    summary     TEXT,
    issue_type  TEXT,                -- as verified in Jira when added
    note        TEXT,
    added_at    TEXT NOT NULL,
    removed_at  TEXT                 -- NULL while tracked
  );
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    logger.info('db migrated', { version: v + 1 });
  }
}

// Runs fn inside a transaction; nested calls join the outer one.
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
