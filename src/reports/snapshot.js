// Compact per-issue snapshots for reports, and a deterministic diff between two.
// A snapshot maps issue key → [phase, points, owner].

const RANK = { todo: 0, blocked: 1, inProgress: 2, review: 3, done: 4 };

export function diffSnapshot(prev = {}, curr = {}) {
  const added = [];
  const removed = [];
  const newlyDone = [];
  const newlyBlocked = [];
  const moved = [];
  for (const [key, [phase]] of Object.entries(curr)) {
    const before = prev[key];
    if (!before) {
      added.push(key);
      continue;
    }
    const was = before[0];
    if (was === phase) continue;
    if (phase === 'done') newlyDone.push(key);
    else if (phase === 'blocked') newlyBlocked.push(key);
    else moved.push({ key, from: was, to: phase, backwards: (RANK[phase] ?? 0) < (RANK[was] ?? 0) });
  }
  for (const key of Object.keys(prev)) if (!(key in curr)) removed.push(key);
  return { added, removed, newlyDone, newlyBlocked, moved };
}

// Midnight today on this machine's clock, as ISO — "since yesterday" comparisons
// use the latest snapshot taken before it, so re-running a report the same day
// still compares against the previous day.
export function startOfLocalDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
