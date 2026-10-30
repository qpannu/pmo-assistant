import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents, eventsOnDay } from '../src/outlook/ics.js';
import { createIcsCalendarSource } from '../src/outlook/calendar.js';
import { zonedHHMM } from '../src/time.js';
import { setLogLevel } from '../src/logger.js';

setLogLevel('error');
const TZ = 'America/New_York';
const FRIDAY = new Date('2026-10-30T11:00:00Z'); // Fri Oct 30, 07:00 ET

// Shaped like an Outlook "Publish calendar" feed (Windows TZ names, folded lines, CRLF).
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Microsoft Exchange Server 2010',
  'BEGIN:VTIMEZONE', 'TZID:Eastern Standard Time', 'END:VTIMEZONE',
  // one-off meeting I organize, with attendees and a Teams link in a folded description
  'BEGIN:VEVENT', 'UID:ez1', 'SUMMARY:ezCater - Touchpoint meeting',
  'DTSTART;TZID=Eastern Standard Time:20261030T110000', 'DTEND;TZID=Eastern Standard Time:20261030T113000',
  'ORGANIZER;CN=Qaiser Pannu:mailto:qpannu@madmobile.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Benjamin Roedell:mailto:benjamin.roedell@madmobile.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Zohra Bhayani:mailto:zohra@madmobile.com',
  'DESCRIPTION:Team updates\\, blockers. Join: https://teams.microsoft.com/l/meetup-',
  ' join/19%3ameeting_abc%40thread.v2/0',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'END:VEVENT',
  // multi-day all-day PTO (shown as free)
  'BEGIN:VEVENT', 'UID:pto1', 'SUMMARY:Sowjanya-PTO', 'DTSTART;VALUE=DATE:20261016', 'DTEND;VALUE=DATE:20261113',
  'X-MICROSOFT-CDO-BUSYSTATUS:FREE', 'TRANSP:TRANSPARENT', 'END:VEVENT',
  // weekly Friday series from September (EDT) — still 09:00 local after DST ends; one week excluded
  'BEGIN:VEVENT', 'UID:wk1', 'SUMMARY:Weekly sync',
  'DTSTART;TZID=Eastern Standard Time:20260904T090000', 'DTEND;TZID=Eastern Standard Time:20260904T093000',
  'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;WKST=SU', 'EXDATE;TZID=Eastern Standard Time:20261023T090000', 'END:VEVENT',
  // bi-weekly Thursday — not today
  'BEGIN:VEVENT', 'UID:bi1', 'SUMMARY:Restaurant Engineering - Biweekly Touchpoint',
  'DTSTART;TZID=Eastern Standard Time:20261001T110000', 'DTEND;TZID=Eastern Standard Time:20261001T113000',
  'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'END:VEVENT',
  // daily standup with today's occurrence moved to 15:00
  'BEGIN:VEVENT', 'UID:su1', 'SUMMARY:Standup', 'DTSTART;TZID=Eastern Standard Time:20261001T100000',
  'DTEND;TZID=Eastern Standard Time:20261001T101500', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:su1', 'SUMMARY:Standup (moved)', 'RECURRENCE-ID;TZID=Eastern Standard Time:20261030T100000',
  'DTSTART;TZID=Eastern Standard Time:20261030T150000', 'DTEND;TZID=Eastern Standard Time:20261030T151500', 'END:VEVENT',
  // last Friday of the month
  'BEGIN:VEVENT', 'UID:mo1', 'SUMMARY:Month-end release review', 'DTSTART;TZID=Eastern Standard Time:20260925T160000',
  'DTEND;TZID=Eastern Standard Time:20260925T170000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'END:VEVENT',
  // personal blocked time
  'BEGIN:VEVENT', 'UID:ap1', 'SUMMARY:Appointment', 'DTSTART;TZID=Eastern Standard Time:20261030T123000',
  'DTEND;TZID=Eastern Standard Time:20261030T140000', 'END:VEVENT',
  // cancelled, COUNT-limited and UNTIL-ended series — none today
  'BEGIN:VEVENT', 'UID:c1', 'SUMMARY:Canceled: Vendor call', 'STATUS:CANCELLED', 'DTSTART:20261030T130000Z', 'DTEND:20261030T133000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:n1', 'SUMMARY:Three-day workshop', 'DTSTART;TZID=Eastern Standard Time:20261020T130000',
  'DTEND;TZID=Eastern Standard Time:20261020T140000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:u1', 'SUMMARY:Old weekly', 'DTSTART;TZID=Eastern Standard Time:20260904T140000',
  'DTEND;TZID=Eastern Standard Time:20260904T143000', 'RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261016T180000Z', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

describe('ICS parsing and recurrence', () => {
  const events = parseEvents(ICS, TZ);

  test('parses Outlook events, unfolds lines, maps Windows time zones', () => {
    const ez = events.find((e) => e.uid === 'ez1');
    assert.equal(ez.start.utc.toISOString(), '2026-10-30T15:00:00.000Z', '11:00 Eastern (EDT)');
    assert.equal(ez.attendees[0].name, 'Benjamin Roedell');
    assert.equal(ez.attendees[0].response, 'accepted');
    assert.match(ez.description, /Team updates, blockers\. Join: https:\/\/teams\.microsoft\.com\/l\/meetup-join\/19%3ameeting_abc/);
  });

  test("today's instances: series, moved occurrence, all-day PTO; not cancelled, ended or other days", () => {
    const today = eventsOnDay(events, { timeZone: TZ, now: FRIDAY });
    const list = today.map((e) => `${e.allDay ? 'all-day' : zonedHHMM(e.startUtc, TZ)} ${e.summary}`);
    assert.deepEqual(list, [
      'all-day Sowjanya-PTO',
      '09:00 Weekly sync',
      '11:00 ezCater - Touchpoint meeting',
      '12:30 Appointment',
      '15:00 Standup (moved)',
      '16:00 Month-end release review',
    ]);
  });

  test('exception dates, interval and DST', () => {
    const on = (iso) => eventsOnDay(events, { timeZone: TZ, now: new Date(iso) }).map((e) => `${zonedHHMM(e.startUtc, TZ)} ${e.summary}`);
    assert.ok(!on('2026-10-23T12:00:00Z').some((x) => /Weekly sync/.test(x)), 'EXDATE skips Oct 23');
    assert.ok(on('2026-11-06T13:00:00Z').includes('09:00 Weekly sync'), '09:00 local after DST ends (14:00 UTC)');
    assert.ok(on('2026-10-29T12:00:00Z').includes('11:00 Restaurant Engineering - Biweekly Touchpoint'), 'Oct 29 is an on-week');
    assert.ok(!on('2026-10-22T12:00:00Z').some((x) => /Biweekly/.test(x)), 'Oct 22 is an off-week');
    assert.ok(on('2026-10-21T12:00:00Z').includes('13:00 Three-day workshop'), 'COUNT day 2');
    assert.ok(!on('2026-10-23T12:00:00Z').some((x) => /workshop/.test(x)), 'COUNT exhausted');
    assert.ok(on('2026-10-29T12:00:00Z').includes('10:00 Standup'), 'unmoved standup on other days');
  });
});

describe('calendar from the published feed', () => {
  const source = (text, extra = {}) => createIcsCalendarSource({
    url: 'https://outlook.office365.com/owa/calendar/abc/def/calendar.ics', timeZone: TZ, myEmails: ['qpannu@madmobile.com'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => text }), ...extra,
  });

  test('meetings, blocked time, who is out and free windows', async () => {
    const cal = await source(ICS)({ now: FRIDAY });
    assert.deepEqual(cal.out, ['Sowjanya']);
    const ez = cal.meetings.find((m) => /ezCater/.test(m.subject));
    assert.equal(ez.start, '11:00');
    assert.equal(ez.youOrganize, true);
    assert.deepEqual(ez.accepted, ['Benjamin Roedell']);
    assert.match(ez.joinUrl, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
    assert.equal(cal.meetings.find((m) => m.subject === 'Appointment').blockedTime, true);
    assert.deepEqual(cal.freeWindows, ['08:00–09:00', '09:30–11:00', '11:30–12:30', '14:00–15:00', '15:15–16:00', '17:00–18:00']);
  });

  test('clear errors for a bad link and a non-ICS page; feed is cached', async () => {
    assert.throws(() => createIcsCalendarSource({ url: 'webcal://x', timeZone: TZ }), /https link/);
    await assert.rejects(source('<html>')({ now: FRIDAY }), /did not return an ICS feed/);
    const gone = createIcsCalendarSource({ url: 'https://x.example/c.ics', timeZone: TZ, fetchImpl: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(gone({ now: FRIDAY }), /HTTP 404 \(link revoked/);
    let fetches = 0;
    const counted = source(ICS, { fetchImpl: async () => { fetches++; return { ok: true, status: 200, text: async () => ICS }; } });
    await counted({ now: FRIDAY });
    await counted({ now: new Date(FRIDAY.getTime() + 60_000) });
    assert.equal(fetches, 1);
  });

  test('the briefing uses the feed instead of saying "not available"', async () => {
    const { openDb } = await import('../src/db.js');
    const { createStore } = await import('../src/store.js');
    const { createClaude } = await import('../src/claude/client.js');
    const { createTeamsNotifier } = await import('../src/notify/teams.js');
    const { createBriefingService } = await import('../src/briefing/briefing.js');
    const { seedSample } = await import('./fixtures/sample-data.js');
    const store = createStore(openDb(':memory:'));
    seedSample(store, FRIDAY);
    const svc = createBriefingService({
      store, claude: createClaude({ store, model: 'm', enabled: false }), timeZone: TZ,
      notifier: createTeamsNotifier({ webhookUrl: 'https://x.example/hook', fetchImpl: async () => ({ ok: true, status: 202 }) }),
      live: { calendar: source(ICS) },
    });
    const r = await svc.run('morning', { now: FRIDAY });
    assert.doesNotMatch(r.content, /calendar not connected/);
    assert.match(r.content, /11:00–11:30 — \[ezCater - Touchpoint meeting\]\(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^)]+\) \(you organize\) — accepted: Benjamin Roedell/);
    assert.match(r.content, /12:30–14:00 — Blocked \(Appointment\)/);
    assert.match(r.content, /Free: 08:00–09:00, 09:30–11:00, 11:30–12:30, 14:00–15:00, 15:15–16:00, 17:00–18:00/);
    assert.match(r.content, /Out today: Sowjanya/);
  });
});
