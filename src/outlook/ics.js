// Minimal iCalendar (ICS) reader for a published Outlook calendar — enough to
// list one day's events: recurring series (RRULE daily/weekly/monthly/yearly
// with INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS, UNTIL, COUNT), EXDATE,
// moved/cancelled occurrences (RECURRENCE-ID), all-day events, Outlook's
// Windows time-zone names and busy status. No dependency.

import { assertTimeZone, dayKey, wallTimeToUtc, zonedParts } from '../time.js';

const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', UTC: 'UTC', 'Coordinated Universal Time': 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'India Standard Time': 'Asia/Kolkata', 'Sri Lanka Standard Time': 'Asia/Colombo', 'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86_400_000;
const MAX_ITER = 4000;

function resolveTz(tzid, fallback) {
  if (!tzid) return fallback;
  const clean = tzid.replace(/^"|"$/g, '');
  if (WINDOWS_TZ[clean]) return WINDOWS_TZ[clean];
  try {
    assertTimeZone(clean);
    return clean;
  } catch {
    return fallback;
  }
}

// Unfolded lines → [{ name, params, value }]
export function parseLines(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  return unfolded.split('\n').filter(Boolean).map((line) => {
    let inQuote = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuote = !inQuote;
      else if (line[i] === ':' && !inQuote) { colon = i; break; }
    }
    if (colon < 0) return null;
    const [name, ...rawParams] = line.slice(0, colon).split(';');
    const params = Object.fromEntries(rawParams.map((p) => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, '')];
    }));
    return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
  }).filter(Boolean);
}

const unescape = (v = '') => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// Date-time value → { date: {y,m,d}, time: {h,mi,s} | null, utc: Date | null, tz }
function parseDateValue(value, params, defaultTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const date = { y: +m[1], m: +m[2], d: +m[3] };
  if (!m[4] || params.VALUE === 'DATE') return { date, time: null, allDay: true };
  const time = { h: +m[4], mi: +m[5], s: +m[6] };
  if (m[7]) return { date, time, utc: new Date(Date.UTC(date.y, date.m - 1, date.d, time.h, time.mi, time.s)), tz: 'UTC' };
  const tz = resolveTz(params.TZID, defaultTz);
  return { date, time, utc: wallTimeToUtc(date.y, date.m, date.d, time.h, time.mi, tz, time.s), tz };
}

export function parseEvents(text, defaultTz) {
  const events = [];
  let cur = null;
  for (const { name, params, value } of parseLines(text)) {
    if (name === 'BEGIN' && value === 'VEVENT') { cur = { exdates: [], attendees: [] }; continue; }
    if (name === 'END' && value === 'VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescape(value); break;
      case 'LOCATION': cur.location = unescape(value); break;
      case 'DESCRIPTION': cur.description = unescape(value); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'TRANSP': cur.transparent = value.toUpperCase() === 'TRANSPARENT'; break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': cur.busy = value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(value, params, defaultTz); break;
      case 'DTEND': cur.end = parseDateValue(value, params, defaultTz); break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('='))); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(value, params, defaultTz); break;
      case 'EXDATE': for (const v of value.split(',')) { const d = parseDateValue(v, params, defaultTz); if (d) cur.exdates.push(d); } break;
      case 'ORGANIZER': cur.organizer = { name: params.CN ?? null, email: value.replace(/^mailto:/i, '').toLowerCase() }; break;
      case 'ATTENDEE': cur.attendees.push({ name: params.CN ?? null, email: value.replace(/^mailto:/i, '').toLowerCase(), response: (params.PARTSTAT ?? '').toLowerCase(), required: params.ROLE !== 'OPT-PARTICIPANT' }); break;
      default:
    }
  }
  return events.filter((e) => e.start);
}

// ─── Recurrence ──────────────────────────────────────────────────────────────
const dayNum = ({ y, m, d }) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const fromDayNum = (n) => { const t = new Date(n * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = (date) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Does `date` belong to the recurrence set's candidate days (ignoring COUNT/UNTIL)?
function ruleMatches(rule, start, date) {
  const interval = Number(rule.INTERVAL ?? 1);
  const freq = rule.FREQ;
  const byDay = rule.BYDAY ? rule.BYDAY.split(',') : null;
  const dn = dayNum(date);
  const sn = dayNum(start);
  if (dn < sn) return false;

  if (freq === 'DAILY') {
    if ((dn - sn) % interval) return false;
    return !byDay || byDay.some((b) => DAYS[b.slice(-2)] === weekday(date));
  }
  if (freq === 'WEEKLY') {
    const wkst = DAYS[rule.WKST ?? 'MO'];
    const weekStart = (n) => n - ((weekday(fromDayNum(n)) - wkst + 7) % 7);
    if (((weekStart(dn) - weekStart(sn)) / 7) % interval) return false;
    const days = byDay ? byDay.map((b) => DAYS[b.slice(-2)]) : [weekday(start)];
    return days.includes(weekday(date));
  }
  const months = (date.y - start.y) * 12 + (date.m - start.m);
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    if (freq === 'MONTHLY' && months % interval) return false;
    if (freq === 'YEARLY' && ((date.y - start.y) % interval || date.m !== Number(rule.BYMONTH ?? start.m))) return false;
    if (rule.BYMONTHDAY) {
      const dim = daysInMonth(date.y, date.m);
      return rule.BYMONTHDAY.split(',').map(Number).some((n) => (n > 0 ? n : dim + n + 1) === date.d);
    }
    if (byDay) {
      // Candidate days in this month, then pick by ordinal (2TU, -1FR) or BYSETPOS.
      const dim = daysInMonth(date.y, date.m);
      const all = [];
      for (let d = 1; d <= dim; d++) {
        const wd = weekday({ y: date.y, m: date.m, d });
        for (const b of byDay) if (DAYS[b.slice(-2)] === wd) all.push({ d, ord: b.slice(0, -2) });
      }
      let picks = all.filter((c) => {
        if (!c.ord) return true;
        const same = all.filter((x) => weekday({ y: date.y, m: date.m, d: x.d }) === weekday({ y: date.y, m: date.m, d: c.d }));
        const n = Number(c.ord);
        return same[n > 0 ? n - 1 : same.length + n]?.d === c.d;
      }).map((c) => c.d);
      if (rule.BYSETPOS) {
        const sorted = [...new Set(picks)].sort((a, b) => a - b);
        picks = rule.BYSETPOS.split(',').map(Number).map((p) => sorted[p > 0 ? p - 1 : sorted.length + p]).filter(Boolean);
      }
      return picks.includes(date.d);
    }
    return date.d === start.d;
  }
  return false;
}

function occursOn(event, date, untilUtc) {
  const rule = event.rrule;
  const start = event.start.date;
  if (!ruleMatches(rule, start, date)) return false;
  if (untilUtc && wallStart(event, date) > untilUtc) return false;
  if (rule.COUNT) {
    let count = 0;
    for (let n = dayNum(start), end = dayNum(date), i = 0; n <= end && i < MAX_ITER; n++, i++) {
      if (ruleMatches(rule, start, fromDayNum(n))) count++;
    }
    if (count > Number(rule.COUNT)) return false;
  }
  return true;
}

function wallStart(event, date) {
  const s = event.start;
  if (s.allDay) return new Date(Date.UTC(date.y, date.m - 1, date.d));
  return wallTimeToUtc(date.y, date.m, date.d, s.time.h, s.time.mi, s.tz, s.time.s);
}

const sameInstant = (a, b) => Math.abs(a - b) < 60_000;

// All event instances that overlap the zoned day of `now` in `tz`.
export function eventsOnDay(events, { timeZone, now = new Date() }) {
  const today = zonedParts(now, timeZone);
  const date = { y: today.year, m: today.month, d: today.day };
  const dayStart = wallTimeToUtc(date.y, date.m, date.d, 0, 0, timeZone);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const key = dayKey(now, timeZone);

  const overrides = events.filter((e) => e.recurrenceId);
  const out = [];
  const push = (e, startUtc, endUtc, allDay) => {
    if (e.status === 'CANCELLED') return;
    out.push({ ...e, startUtc, endUtc, allDay });
  };

  for (const e of events.filter((x) => !x.recurrenceId)) {
    const duration = e.end ? (e.end.allDay ? (dayNum(e.end.date) - dayNum(e.start.date)) * DAY_MS : e.end.utc - e.start.utc) : (e.start.allDay ? DAY_MS : 0);
    if (!e.rrule) {
      if (e.start.allDay) {
        const s = dayNum(e.start.date);
        const end = e.end ? dayNum(e.end.date) : s + 1;
        const t = dayNum(date);
        if (t >= s && t < end) push(e, dayStart, dayEnd, true);
      } else if (e.start.utc < dayEnd && new Date(e.start.utc.getTime() + duration) > dayStart) {
        push(e, e.start.utc, new Date(e.start.utc.getTime() + duration), false);
      }
      continue;
    }
    // Recurring: today's occurrence (all-day series use the day itself).
    const until = e.rrule.UNTIL ? parseDateValue(e.rrule.UNTIL, {}, 'UTC') : null;
    const untilUtc = until ? (until.utc ?? new Date(Date.UTC(until.date.y, until.date.m - 1, until.date.d, 23, 59, 59))) : null;
    for (const candidate of [date, fromDayNum(dayNum(date) - 1)]) { // yesterday's late occurrence may spill into today
      if (!occursOn(e, candidate, untilUtc)) continue;
      const startUtc = e.start.allDay ? dayStart : wallStart(e, candidate);
      if (e.start.allDay && candidate !== date) continue;
      const endUtc = e.start.allDay ? dayEnd : new Date(startUtc.getTime() + duration);
      if (!(startUtc < dayEnd && endUtc > dayStart)) continue;
      if (e.exdates.some((x) => (x.allDay ? dayNum(x.date) === dayNum(candidate) : sameInstant(x.utc, startUtc)))) continue;
      const moved = overrides.find((o) => o.uid === e.uid && (o.recurrenceId.allDay ? dayNum(o.recurrenceId.date) === dayNum(candidate) : sameInstant(o.recurrenceId.utc, startUtc)));
      if (moved) continue; // the override is listed on its own date below
      push(e, startUtc, endUtc, Boolean(e.start.allDay));
    }
  }
  // Moved/edited single occurrences.
  for (const o of overrides) {
    const startUtc = o.start.allDay ? wallTimeToUtc(o.start.date.y, o.start.date.m, o.start.date.d, 0, 0, timeZone) : o.start.utc;
    const endUtc = o.end ? (o.end.allDay ? wallTimeToUtc(o.end.date.y, o.end.date.m, o.end.date.d, 0, 0, timeZone) : o.end.utc) : new Date(startUtc.getTime() + DAY_MS);
    if (startUtc < dayEnd && endUtc > dayStart) push(o, startUtc, endUtc, Boolean(o.start.allDay));
  }
  return out.sort((a, b) => a.startUtc - b.startUtc).map((e) => ({ ...e, day: key }));
}
