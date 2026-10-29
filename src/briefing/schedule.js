// Fires each briefing once per working day at its local time. If the service
// starts late (or delivery failed), it catches up within a grace window.

import { logger } from '../logger.js';
import { localToday } from '../jira/classify.js';
import { KINDS } from './briefing.js';

const log = logger.child({ component: 'briefing-schedule' });
const GRACE_MINUTES = 180;
const MAX_ATTEMPTS_PER_DAY = 5;

const parseTime = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`Invalid time "${hhmm}" (use HH:MM)`);
  return { h, m };
};

// Pure check, exported for tests.
export function isDue(kind, now, { times, days }, store, attempts = 0) {
  if (!days.includes(now.getDay()) || attempts >= MAX_ATTEMPTS_PER_DAY) return false;
  const { h, m } = parseTime(times[kind]);
  const start = new Date(now);
  start.setHours(h, m, 0, 0);
  const minutesLate = (now - start) / 60_000;
  if (minutesLate < 0 || minutesLate > GRACE_MINUTES) return false;
  return !store.getBriefing(kind, localToday(now))?.sent_at;
}

export function startBriefingSchedule({ store, briefings, times, days, intervalMs = 60_000 }) {
  KINDS.forEach((k) => parseTime(times[k]));
  const attempts = new Map(); // `${kind}:${day}` → count
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      for (const kind of KINDS) {
        const key = `${kind}:${localToday(now)}`;
        if (!isDue(kind, now, { times, days }, store, attempts.get(key) ?? 0)) continue;
        attempts.set(key, (attempts.get(key) ?? 0) + 1);
        await briefings.run(kind, { now });
      }
    } catch (err) {
      log.error('briefing schedule error', { error: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 15_000).unref();
  log.info('briefings scheduled', { ...times, days });
  return { stop: () => clearInterval(timer), tick };
}
