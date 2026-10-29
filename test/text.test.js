import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntents, extractJiraKeys, htmlToText, parseDeadline } from '../src/text.js';

test('detects questions, requests, approvals, decisions, urgency, releases and commitments', () => {
  assert.equal(detectIntents('Can you review the plan?').question, true);
  assert.equal(detectIntents('Please send the numbers').request, true);
  assert.equal(detectIntents('Need your sign-off for 8.886').approval, true);
  assert.equal(detectIntents('We need a go/no-go for tonight').approval, true);
  assert.equal(detectIntents('Which option should we take, A or B').decision, true);
  assert.equal(detectIntents('Prod is down for Sweet Eatery, P1').urgent, true);
  assert.equal(detectIntents('Rollback plan for the release').release, true);
  assert.equal(detectIntents("I'll send the RCA by Friday").commitment, true);
  assert.deepEqual(Object.values(detectIntents('FYI, the newsletter is out.')).filter(Boolean), []);
});

test('extracts Jira keys once each', () => {
  assert.deepEqual(extractJiraKeys('REST-21533 and UP-5120, again REST-21533'), ['REST-21533', 'UP-5120']);
  assert.deepEqual(extractJiraKeys('ISO-8601 dates are not issues? x-1'), ['ISO-8601']);
});

test('converts Teams/Outlook HTML to text', () => {
  assert.equal(htmlToText('<p>Hi <at id="0">Qaiser</at>,</p><p>can you&nbsp;check &amp; confirm?</p>'), 'Hi Qaiser,\ncan you check & confirm?');
});

test('parses deadlines relative to the message date', () => {
  const thu = new Date(2026, 9, 29); // Thu 29 Oct 2026
  assert.equal(parseDeadline('please send by EOD', thu).date, '2026-10-29');
  assert.equal(parseDeadline('due tomorrow', thu).date, '2026-10-30');
  assert.equal(parseDeadline('need it by Monday', thu).date, '2026-11-02');
  assert.equal(parseDeadline('by Thursday', thu).date, '2026-11-05', 'same weekday means next week');
  assert.equal(parseDeadline('before 11/3', thu).date, '2026-11-03');
  assert.equal(parseDeadline('no later than Nov 12th', thu).date, '2026-11-12');
  assert.equal(parseDeadline('by Jan 5', new Date(2026, 11, 20)).date, '2027-01-05');
  assert.equal(parseDeadline('by end of week', thu).date, '2026-10-30');
  assert.equal(parseDeadline('nothing here', thu), null);
});
