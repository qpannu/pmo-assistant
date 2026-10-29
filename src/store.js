// Data access for the PMO assistant. Every write that matters is idempotent
// (keyed by source id, dedupe key or status guard) so retries and repeated
// events can't create duplicates or double-send anything.

import { createHash } from 'node:crypto';
import { transaction } from './db.js';

const now = () => new Date().toISOString();

// Key-order-independent JSON, so the same content always hashes the same.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function contentHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);

  function addHistory(entityType, entityId, event, detail) {
    stmt(`INSERT INTO history (entity_type, entity_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entityType, entityId ?? null, event, detail === undefined ? null : JSON.stringify(detail), now());
  }

  // ─── Sync cursors ──────────────────────────────────────────────────────────
  function getSyncState(source) {
    return stmt(`SELECT * FROM sync_state WHERE source = ?`).get(source) ?? null;
  }

  function saveSyncSuccess(source, cursor) {
    const ts = now();
    stmt(`
      INSERT INTO sync_state (source, cursor, last_success_at, last_error, updated_at) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at,
        last_error = NULL, updated_at = excluded.updated_at
    `).run(source, cursor ?? null, ts, ts);
  }

  function saveSyncError(source, message) {
    stmt(`
      INSERT INTO sync_state (source, last_error, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (source) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at
    `).run(source, String(message).slice(0, 1000), now());
  }

  // ─── Duplicate-event protection ────────────────────────────────────────────
  // Returns true the first time an event is seen, false for every repeat.
  function claimEvent(source, eventId) {
    const r = stmt(`INSERT OR IGNORE INTO processed_events (source, event_id, received_at) VALUES (?, ?, ?)`)
      .run(source, String(eventId), now());
    return r.changes === 1;
  }

  function pruneProcessedEvents(olderThanDays = 30) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return stmt(`DELETE FROM processed_events WHERE received_at < ?`).run(cutoff).changes;
  }

  // ─── Items ─────────────────────────────────────────────────────────────────
  // Inserts or updates a source record. `changed` is false when the content is
  // identical to what we already have, so callers can skip all further work.
  function upsertItem({ source, externalId, kind, title = null, url = null, author = null, project = null, occurredAt = null, threadKey = null, data = {} }) {
    const hash = contentHash({ kind, title, author, project, data });
    const ts = now();
    return transaction(db, () => {
      const existing = stmt(`SELECT id, content_hash FROM items WHERE source = ? AND external_id = ?`).get(source, externalId);
      if (existing?.content_hash === hash) return { id: existing.id, isNew: false, changed: false };
      if (existing) {
        stmt(`UPDATE items SET kind = ?, title = ?, url = ?, author = ?, project = ?, occurred_at = ?, thread_key = ?, data = ?,
                content_hash = ?, updated_at = ? WHERE id = ?`)
          .run(kind, title, url, author, project, occurredAt, threadKey, JSON.stringify(data), hash, ts, existing.id);
        return { id: existing.id, isNew: false, changed: true };
      }
      const r = stmt(`INSERT INTO items (source, external_id, kind, title, url, author, project, occurred_at, thread_key, data,
                        content_hash, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(source, externalId, kind, title, url, author, project, occurredAt, threadKey, JSON.stringify(data), hash, ts, ts);
      return { id: Number(r.lastInsertRowid), isNew: true, changed: true };
    });
  }

  const parseRow = (r) => ({ ...r, data: JSON.parse(r.data) });

  function getItemByExternalId(source, externalId) {
    const row = stmt(`SELECT * FROM items WHERE source = ? AND external_id = ?`).get(source, externalId);
    return row ? parseRow(row) : null;
  }

  function listThread(source, threadKey) {
    return stmt(`SELECT * FROM items WHERE source = ? AND thread_key = ? ORDER BY occurred_at`).all(source, threadKey).map(parseRow);
  }

  // Items of a source that occurred on/after `since` (ISO), for local re-evaluation.
  function listItemsSince(source, since) {
    return stmt(`SELECT * FROM items WHERE source = ? AND occurred_at >= ? ORDER BY occurred_at`).all(source, since).map(parseRow);
  }

  // Items whose current content hasn't been turned into action items yet.
  function itemsNeedingActions(limit = 1000) {
    return stmt(`SELECT * FROM items WHERE actions_hash IS NOT content_hash ORDER BY id LIMIT ?`).all(limit).map(parseRow);
  }

  function markActionsDerived(itemId, hash) {
    stmt(`UPDATE items SET actions_hash = ? WHERE id = ?`).run(hash, itemId);
  }

  function getItem(id) {
    const row = stmt(`SELECT * FROM items WHERE id = ?`).get(id);
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  }

  function listItems({ source, kind }) {
    return stmt(`SELECT * FROM items WHERE source = ? AND kind = ? ORDER BY occurred_at DESC`).all(source, kind)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  function itemsNeedingAnalysis({ source, limit = 50 } = {}) {
    const rows = source
      ? stmt(`SELECT * FROM items WHERE analyzed_hash IS NOT content_hash AND source = ? ORDER BY updated_at LIMIT ?`).all(source, limit)
      : stmt(`SELECT * FROM items WHERE analyzed_hash IS NOT content_hash ORDER BY updated_at LIMIT ?`).all(limit);
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  // Pass the hash that was actually analysed: if the item changed meanwhile it
  // stays pending and is picked up on the next run.
  function markAnalyzed(itemId, analyzedHash) {
    stmt(`UPDATE items SET analyzed_hash = ? WHERE id = ?`).run(analyzedHash, itemId);
  }

  // ─── Action items ──────────────────────────────────────────────────────────
  // Re-analysis refreshes details but never reopens something I closed or
  // dismissed. Items the system auto-closed (trigger went away) reopen when a
  // new trigger arrives.
  function upsertActionItem({ dedupeKey, itemId = null, type, title, summary = null, project = null, priority = 3, dueAt = null }) {
    const ts = now();
    return transaction(db, () => {
      const existing = stmt(`SELECT id, status, closed_reason FROM action_items WHERE dedupe_key = ?`).get(dedupeKey);
      if (existing) {
        stmt(`UPDATE action_items SET item_id = COALESCE(?, item_id), type = ?, title = ?, summary = ?, project = ?,
                priority = ?, due_at = ?, updated_at = ? WHERE id = ?`)
          .run(itemId, type, title, summary, project, priority, dueAt, ts, existing.id);
        const reopened = existing.status === 'done' && existing.closed_reason === 'auto';
        if (reopened) {
          stmt(`UPDATE action_items SET status = 'open', closed_at = NULL, closed_reason = NULL WHERE id = ?`).run(existing.id);
          addHistory('action_item', existing.id, 'reopened');
        }
        return { id: existing.id, created: false, reopened };
      }
      const r = stmt(`INSERT INTO action_items (dedupe_key, item_id, type, title, summary, project, priority, due_at,
                        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(dedupeKey, itemId, type, title, summary, project, priority, dueAt, ts, ts);
      const id = Number(r.lastInsertRowid);
      addHistory('action_item', id, 'created', { type, title });
      return { id, created: true };
    });
  }

  // reason: 'user' (my decision, never undone automatically) or 'auto'.
  function setActionStatus(id, status, { snoozedUntil = null, reason = 'user' } = {}) {
    if (status === 'snoozed' && !snoozedUntil) throw new Error('snoozedUntil is required when snoozing');
    const ts = now();
    const isClosed = status === 'done' || status === 'dismissed';
    return transaction(db, () => {
      const r = stmt(`UPDATE action_items SET status = ?, snoozed_until = ?, closed_at = ?, closed_reason = ?, updated_at = ? WHERE id = ?`)
        .run(status, status === 'snoozed' ? snoozedUntil : null, isClosed ? ts : null, isClosed ? reason : null, ts, id);
      if (r.changes) {
        const detail = { ...(snoozedUntil && { snoozedUntil }), ...(reason !== 'user' && { reason }) };
        addHistory('action_item', id, `status:${status}`, Object.keys(detail).length ? detail : undefined);
      }
      return r.changes === 1;
    });
  }

  function getActionItem(id) {
    return stmt(`SELECT * FROM action_items WHERE id = ?`).get(id) ?? null;
  }

  function linkActionSource(actionItemId, itemId) {
    stmt(`INSERT OR IGNORE INTO action_item_sources (action_item_id, item_id, linked_at) VALUES (?, ?, ?)`).run(actionItemId, itemId, now());
  }

  function unlinkActionSource(actionItemId, itemId) {
    stmt(`DELETE FROM action_item_sources WHERE action_item_id = ? AND item_id = ?`).run(actionItemId, itemId);
  }

  function actionsForItem(itemId) {
    return stmt(`SELECT a.* FROM action_items a JOIN action_item_sources s ON s.action_item_id = a.id WHERE s.item_id = ?`).all(itemId);
  }

  // Source items behind an action, newest first, with links back to the originals.
  function listActionSources(actionItemId) {
    return stmt(`SELECT i.id, i.source, i.kind, i.title, i.url, i.author, i.occurred_at FROM items i
      JOIN action_item_sources s ON s.item_id = i.id WHERE s.action_item_id = ? ORDER BY i.occurred_at DESC`).all(actionItemId);
  }

  // Full source items (with data) behind an action, for scoring and evidence.
  function listActionSourceItems(actionItemId) {
    return stmt(`SELECT i.* FROM items i JOIN action_item_sources s ON s.item_id = i.id
      WHERE s.action_item_id = ? ORDER BY i.occurred_at`).all(actionItemId).map(parseRow);
  }

  // Writes only when the ranking actually changed, so unchanged runs are no-ops.
  function saveActionRanking(id, { score, category, reasons }) {
    const json = JSON.stringify(reasons);
    const r = stmt(`UPDATE action_items SET score = ?, category = ?, score_reasons = ?, ranked_at = ?
      WHERE id = ? AND (score IS NOT ? OR category IS NOT ? OR score_reasons IS NOT ?)`)
      .run(score, category, json, now(), id, score, category, json);
    return r.changes === 1;
  }

  function countActionSources(actionItemId) {
    return stmt(`SELECT COUNT(*) AS n FROM action_item_sources WHERE action_item_id = ?`).get(actionItemId).n;
  }

  // Open items plus snoozed ones whose snooze has expired; most urgent first.
  function listOpenActions({ project } = {}) {
    const ts = now();
    const base = `SELECT * FROM action_items
      WHERE (status = 'open' OR (status = 'snoozed' AND snoozed_until <= ?))`;
    const order = ` ORDER BY priority, due_at IS NULL, due_at, created_at`;
    return project
      ? stmt(base + ` AND project = ?` + order).all(ts, project)
      : stmt(base + order).all(ts);
  }

  // ─── Alerts ────────────────────────────────────────────────────────────────
  // created = false means this alert was already raised; don't notify again.
  function raiseAlert({ dedupeKey, itemId = null, actionItemId = null, severity, title, detail = null }) {
    const r = stmt(`INSERT OR IGNORE INTO alerts (dedupe_key, item_id, action_item_id, severity, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(dedupeKey, itemId, actionItemId, severity, title, detail, now());
    if (r.changes) return { id: Number(r.lastInsertRowid), created: true };
    return { id: stmt(`SELECT id FROM alerts WHERE dedupe_key = ?`).get(dedupeKey).id, created: false };
  }

  function acknowledgeAlert(id) {
    return stmt(`UPDATE alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`).run(now(), id).changes === 1;
  }

  function listActiveAlerts() {
    return stmt(`SELECT * FROM alerts WHERE acknowledged_at IS NULL
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`).all();
  }

  // ─── Drafts (approval gate) ────────────────────────────────────────────────
  // pending → approved | rejected; approved → sending → sent | failed.
  // Only claimDraftForSend() hands a draft to a sender, and only once.
  function createDraft({ actionItemId = null, channel, target, subject = null, body }) {
    const r = stmt(`INSERT INTO drafts (action_item_id, channel, target, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(actionItemId, channel, JSON.stringify(target), subject, body, now());
    const id = Number(r.lastInsertRowid);
    addHistory('draft', id, 'created', { channel });
    return id;
  }

  function getDraft(id) {
    const row = stmt(`SELECT * FROM drafts WHERE id = ?`).get(id);
    return row ? { ...row, target: JSON.parse(row.target) } : null;
  }

  function listDrafts(status = 'pending') {
    return stmt(`SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC`).all(status)
      .map((r) => ({ ...r, target: JSON.parse(r.target) }));
  }

  function editDraft(id, { subject, body }) {
    const r = stmt(`UPDATE drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body) WHERE id = ? AND status = 'pending'`)
      .run(subject ?? null, body ?? null, id);
    if (r.changes) addHistory('draft', id, 'edited');
    return r.changes === 1;
  }

  function transitionDraft(id, from, to, extra = {}) {
    const cols = Object.keys(extra);
    const sets = [`status = ?`, ...cols.map((c) => `${c} = ?`)].join(', ');
    return transaction(db, () => {
      const r = stmt(`UPDATE drafts SET ${sets} WHERE id = ? AND status = ?`).run(to, ...cols.map((c) => extra[c]), id, from);
      if (r.changes) addHistory('draft', id, `status:${to}`, extra.error ? { error: extra.error } : undefined);
      return r.changes === 1;
    });
  }

  const approveDraft = (id) => transitionDraft(id, 'pending', 'approved', { decided_at: now() });
  const rejectDraft = (id) => transitionDraft(id, 'pending', 'rejected', { decided_at: now() });

  function claimDraftForSend(id) {
    return transitionDraft(id, 'approved', 'sending') ? getDraft(id) : null;
  }

  const markDraftSent = (id) => transitionDraft(id, 'sending', 'sent', { sent_at: now() });
  const markDraftFailed = (id, error) => transitionDraft(id, 'sending', 'failed', { error: String(error).slice(0, 1000) });

  function listHistory(entityType, entityId) {
    return stmt(`SELECT * FROM history WHERE entity_type = ? AND entity_id = ? ORDER BY id`).all(entityType, entityId);
  }

  return {
    transaction: (fn) => transaction(db, fn),
    addHistory, listHistory,
    getSyncState, saveSyncSuccess, saveSyncError,
    claimEvent, pruneProcessedEvents,
    upsertItem, getItem, getItemByExternalId, listItems, listThread, listItemsSince,
    itemsNeedingAnalysis, markAnalyzed, itemsNeedingActions, markActionsDerived,
    upsertActionItem, setActionStatus, getActionItem, listOpenActions,
    linkActionSource, unlinkActionSource, actionsForItem, listActionSources, listActionSourceItems,
    countActionSources, saveActionRanking,
    raiseAlert, acknowledgeAlert, listActiveAlerts,
    createDraft, getDraft, listDrafts, editDraft, approveDraft, rejectDraft,
    claimDraftForSend, markDraftSent, markDraftFailed,
  };
}
