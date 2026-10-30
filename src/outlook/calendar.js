// Today's meetings from Outlook (Graph calendarView, Calendars.Read).
// Preparation hints are rule-based: they link meetings to tracked releases,
// Jira keys and items waiting on you, so Claude only has to phrase them.

import { extractJiraKeys, htmlToText, truncate } from '../text.js';
import { dayKey, zonedTimeToUtc } from '../time.js';

const SELECT = 'subject,start,end,organizer,attendees,location,isOnlineMeeting,onlineMeeting,webLink,bodyPreview,isCancelled,isOrganizer,responseStatus,showAs';

export async function todaysMeetings(graph, { timeZone, now = new Date() }) {
  const start = zonedTimeToUtc(now, timeZone, 0, 0).toISOString();
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const { items } = await graph.collect('/me/calendarView', {
    query: { startDateTime: start, endDateTime: end, $select: SELECT, $orderby: 'start/dateTime', $top: 50 },
    headers: { Prefer: `outlook.timezone="${timeZone}"` },
    limit: 50,
  });
  return items
    .filter((m) => !m.isCancelled && m.showAs !== 'free' && m.responseStatus?.response !== 'declined')
    .map((m) => {
      const preview = truncate(htmlToText(m.bodyPreview ?? '').replace(/\s+/g, ' '), 200);
      return {
        subject: m.subject || '(no subject)',
        start: m.start?.dateTime?.slice(11, 16),
        end: m.end?.dateTime?.slice(11, 16),
        day: dayKey(now, timeZone),
        organizer: m.organizer?.emailAddress?.name ?? null,
        youOrganize: Boolean(m.isOrganizer),
        attendees: (m.attendees ?? []).length,
        keyAttendees: (m.attendees ?? []).filter((a) => a.type === 'required').slice(0, 6).map((a) => a.emailAddress?.name).filter(Boolean),
        location: m.location?.displayName || (m.isOnlineMeeting ? 'Teams' : null),
        joinUrl: m.onlineMeeting?.joinUrl ?? null,
        url: m.webLink ?? null,
        purpose: preview || null,
        jiraKeys: extractJiraKeys(`${m.subject} ${preview}`),
      };
    });
}

// What to prepare, from data we already have (no guessing).
export function prepHints(meeting, { releases = [], waiting = [] } = {}) {
  const hints = [];
  const s = `${meeting.subject} ${meeting.purpose ?? ''}`.toLowerCase();
  if (meeting.youOrganize) hints.push('You organize: confirm agenda and attendees');
  if (/go\s*\/?\s*no[- ]?go|release|rollout|deploy/.test(s) && releases.length) {
    hints.push(`Bring release status: ${releases.slice(0, 2).map((r) => `${r.release} (${r.risk})`).join(', ')}`);
  }
  if (meeting.jiraKeys.length) hints.push(`Check ${meeting.jiraKeys.slice(0, 3).join(', ')}`);
  const people = new Set(meeting.keyAttendees.map((n) => n?.toLowerCase()));
  const owed = waiting.filter((w) => w.who && people.has(w.who.toLowerCase())).slice(0, 2);
  if (owed.length) hints.push(`You owe ${owed.map((w) => `${w.who}: ${w.title}`).join('; ')}`);
  return hints;
}
