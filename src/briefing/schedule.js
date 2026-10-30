// Fires each briefing once per working day at its wall-clock time in the
// configured time zone (default America/New_York, DST-aware). If the service
// was down or the machine asleep, it catches up within a grace window;
// after that the run is recorded as missed rather than sent late.

import { logger } from '../logger.js';
import { dayKey, zonedParts } from '../time.js';
import { KINDS } from './briefing.js';

const log = logger.child({ component: 'briefing-schedule' });
const MAX_ATTEMPTS_PER_DAY = 5;

export const parseTime = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`Invalid time "${hhmm}" (use HH:MM)`);
  return { h, m };
};

// Minutes since today's scheduled time in `tz` (negative = not yet).
export function minutesLate(now, tz, hhmm) {
  const { h, m } = parseTime(hhmm);
  const p = zonedParts(now, tz);
  return (p.hour * 60 + p.minute) - (h * 60 + m);
}

// Pure check, exported for tests.
export function isDue(kind, now, { times, days, timeZone, graceMinutes }, store, attempts = 0) {
  if (!times[kind] || attempts >= MAX_ATTEMPTS_PER_DAY) return false;
  if (!days.includes(zonedParts(now, timeZone).weekday)) return false;
  const late = minutesLate(now, timeZone, times[kind]);
  if (late < 0 || late > graceMinutes) return false;
  return !store.getBriefing(kind, dayKey(now, timeZone))?.sent_at;
}

export function startBriefingSchedule({ store, briefings, times, days, timeZone, graceMinutes = 240, intervalMs = 60_000 }) {
  const active = KINDS.filter((k) => times[k]);
  active.forEach((k) => parseTime(times[k]));
  const attempts = new Map(); // `${kind}:${day}` → count
  const reportedMissed = new Set();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const day = dayKey(now, timeZone);
      for (const kind of active) {
        const key = `${kind}:${day}`;
        const cfg = { times, days, timeZone, graceMinutes };
        if (isDue(kind, now, cfg, store, attempts.get(key) ?? 0)) {
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          await briefings.run(kind, { now });
        } else if (days.includes(zonedParts(now, timeZone).weekday) && minutesLate(now, timeZone, times[kind]) > graceMinutes
          && !store.getBriefing(kind, day)?.sent_at && !reportedMissed.has(key)) {
          reportedMissed.add(key);
          log.warn('briefing window missed; not sending late', { kind, day, timeZone });
        }
      }
    } catch (err) {
      log.error('briefing schedule error', { error: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 15_000).unref();
  log.info('briefings scheduled', { ...Object.fromEntries(active.map((k) => [k, times[k]])), days, timeZone, graceMinutes });
  return { stop: () => clearInterval(timer), tick };
}
