// Today's calendar: meetings, blocked time, who is out (all-day PTO/OOO
// events) and free windows in the working day. Two sources, same output:
//   - Microsoft Graph calendarView (Calendars.Read) when signed in,
//   - the published Outlook calendar feed (ICS link) — works without IT.
// Preparation hints are rule-based so Claude only phrases them.

import { extractJiraKeys, htmlToText, truncate } from '../text.js';
import { dayKey, zonedHHMM, zonedTimeToUtc } from '../time.js';
import { parseEvents, eventsOnDay } from './ics.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'calendar' });
const SELECT = 'subject,start,end,organizer,attendees,location,isOnlineMeeting,onlineMeeting,webLink,bodyPreview,isCancelled,isOrganizer,responseStatus,showAs,isAllDay';
const OUT = /\b(pto|ooo|out of office|vacation|leave|holiday|off)\b/i;
const TEAMS_LINK = /https:\/\/teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/[^\s<>"]+/;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Gaps of at least `minGap` minutes between busy blocks inside the working day.
export function freeWindows(busy, { dayStart = '08:00', dayEnd = '18:00', minGap = 30 } = {}) {
  const blocks = busy.map((b) => [toMinutes(b.start), toMinutes(b.end)]).sort((a, b) => a[0] - b[0]);
  const windows = [];
  let cursor = toMinutes(dayStart);
  const end = toMinutes(dayEnd);
  for (const [s, e] of blocks) {
    if (s - cursor >= minGap) windows.push(`${toHHMM(cursor)}–${toHHMM(Math.min(s, end))}`);
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  if (end - cursor >= minGap) windows.push(`${toHHMM(cursor)}–${toHHMM(end)}`);
  return windows;
}

// Normalised events (from either source) → meetings, out, free windows.
export function summarizeDay(events, { timeZone, now }) {
  const live = events.filter((e) => !e.cancelled && !e.declined);
  const out = live.filter((e) => e.isAllDay && OUT.test(e.subject ?? ''))
    .map((e) => truncate(e.subject.replace(/[-–—]?\s*(pto|ooo|out of office)\b.*$/i, '').trim() || e.organizerName || e.subject, 40));

  const meetings = live.filter((e) => !e.isAllDay && e.showAs !== 'free').map((e) => {
    const preview = truncate(htmlToText(e.body ?? '').replace(/\s+/g, ' '), 200);
    return {
      subject: e.subject || '(no subject)',
      start: e.start,
      end: e.end,
      day: dayKey(now, timeZone),
      organizer: e.organizerName ?? null,
      youOrganize: Boolean(e.isOrganizer),
      attendees: e.attendees.length,
      accepted: e.attendees.filter((a) => a.response === 'accepted').map((a) => a.name).filter(Boolean).slice(0, 8),
      keyAttendees: e.attendees.filter((a) => a.required).slice(0, 6).map((a) => a.name).filter(Boolean),
      blockedTime: e.attendees.length === 0 && (e.isOrganizer || !e.organizerName),
      location: e.location || null,
      joinUrl: e.joinUrl ?? null,
      url: e.url ?? null,
      purpose: preview || null,
      jiraKeys: extractJiraKeys(`${e.subject} ${preview}`),
    };
  });
  return { meetings, out, freeWindows: freeWindows(meetings) };
}

// ─── Source 1: Microsoft Graph ───────────────────────────────────────────────
export async function todaysCalendar(graph, { timeZone, now = new Date() }) {
  const start = zonedTimeToUtc(now, timeZone, 0, 0).toISOString();
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const { items } = await graph.collect('/me/calendarView', {
    query: { startDateTime: start, endDateTime: end, $select: SELECT, $orderby: 'start/dateTime', $top: 50 },
    headers: { Prefer: `outlook.timezone="${timeZone}"` },
    limit: 50,
  });
  const events = items.map((m) => ({
    subject: m.subject,
    start: m.start?.dateTime?.slice(11, 16),
    end: m.end?.dateTime?.slice(11, 16),
    isAllDay: Boolean(m.isAllDay),
    showAs: m.showAs,
    cancelled: Boolean(m.isCancelled),
    declined: m.responseStatus?.response === 'declined',
    isOrganizer: Boolean(m.isOrganizer),
    organizerName: m.organizer?.emailAddress?.name ?? null,
    attendees: (m.attendees ?? []).map((a) => ({ name: a.emailAddress?.name, response: a.status?.response, required: a.type === 'required' })),
    location: m.location?.displayName || (m.isOnlineMeeting ? 'Teams' : null),
    joinUrl: m.onlineMeeting?.joinUrl ?? null,
    url: m.webLink ?? null,
    body: m.bodyPreview ?? '',
  }));
  return summarizeDay(events, { timeZone, now });
}

// ─── Source 2: published Outlook calendar (ICS) ─────────────────────────────
// Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar.
export function createIcsCalendarSource({ url, timeZone, myEmails = [], fetchImpl = fetch, cacheMinutes = 10 }) {
  if (!/^https:\/\//.test(url)) throw new Error('OUTLOOK_ICS_URL must be an https link (use the ICS link, not the HTML one)');
  const me = new Set(myEmails.filter(Boolean).map((e) => e.toLowerCase()));
  let cache = null;

  async function load(now) {
    if (cache && now - cache.at < cacheMinutes * 60_000) return cache.events;
    const res = await fetchImpl(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`calendar feed returned HTTP ${res.status}${res.status === 404 ? ' (link revoked? re-publish the calendar)' : ''}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('calendar link did not return an ICS feed (use the .ics link)');
    const events = parseEvents(text, timeZone);
    cache = { at: now, events };
    log.info('calendar feed loaded', { events: events.length });
    return events;
  }

  return async function todaysCalendarFromIcs({ now = new Date() } = {}) {
    const instances = eventsOnDay(await load(now), { timeZone, now });
    const events = instances.map((e) => {
      const isAllDay = e.allDay;
      const organizerIsMe = e.organizer ? me.has(e.organizer.email) : !e.attendees.length;
      return {
        subject: e.summary ?? '(no subject)',
        start: zonedHHMM(e.startUtc, timeZone),
        end: zonedHHMM(e.endUtc, timeZone),
        isAllDay,
        showAs: e.transparent || e.busy === 'FREE' ? 'free' : e.busy === 'OOF' ? 'oof' : 'busy',
        cancelled: e.status === 'CANCELLED' || /^canceled:|^cancelled:/i.test(e.summary ?? ''),
        declined: e.attendees.some((a) => me.has(a.email) && a.response === 'declined'),
        isOrganizer: organizerIsMe,
        organizerName: e.organizer?.name ?? null,
        attendees: e.attendees.filter((a) => !me.has(a.email)),
        location: e.location || null,
        joinUrl: (e.description ?? '').match(TEAMS_LINK)?.[0] ?? null,
        url: null,
        body: e.description ?? '',
      };
    });
    return summarizeDay(events, { timeZone, now });
  };
}

// What to prepare, from data we already have (no guessing).
export function prepHints(meeting, { releases = [], waiting = [] } = {}) {
  const hints = [];
  const s = `${meeting.subject} ${meeting.purpose ?? ''}`.toLowerCase();
  if (meeting.youOrganize && !meeting.blockedTime) hints.push('You organize: confirm agenda and attendees');
  if (/go\s*\/?\s*no[- ]?go|release|rollout|deploy/.test(s) && releases.length) {
    hints.push(`Bring release status: ${releases.slice(0, 2).map((r) => `${r.release} (${r.risk})`).join(', ')}`);
  }
  if (meeting.jiraKeys.length) hints.push(`Check ${meeting.jiraKeys.slice(0, 3).join(', ')}`);
  const people = new Set(meeting.keyAttendees.map((n) => n?.toLowerCase()));
  const owed = waiting.filter((w) => w.who && people.has(w.who.toLowerCase())).slice(0, 2);
  if (owed.length) hints.push(`You owe ${owed.map((w) => `${w.who}: ${w.title}`).join('; ')}`);
  return hints;
}
