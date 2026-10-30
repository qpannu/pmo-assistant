// Time-zone helpers (Intl only, no dependencies). Schedules run on a named
// zone such as America/New_York, so daylight saving changes are handled by
// the platform rather than by fixed UTC offsets.

const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  }
  return formatters.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock parts of `date` in `tz`.
export function zonedParts(date, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS[p.weekday],
  };
}

// Calendar day (YYYY-MM-DD) of `date` in `tz` — the key for "once per day".
export function dayKey(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function assertTimeZone(tz) {
  try {
    formatter(tz);
  } catch {
    throw new Error(`Invalid time zone "${tz}" (use an IANA name such as America/New_York)`);
  }
}

// UTC instant of a wall-clock time on the zoned day of `date` (DST-aware).
export function zonedTimeToUtc(date, tz, hour, minute) {
  const p = zonedParts(date, tz);
  let guess = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const g = zonedParts(new Date(guess), tz);
    const diff = (Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute) - Date.UTC(p.year, p.month - 1, p.day, hour, minute));
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}
