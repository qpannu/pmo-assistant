// Cheap, deterministic text rules shared by the email and chat integrations.
// They decide what is worth surfacing; Claude refines wording/priority later.

const RX = {
  question: /\?(\s|$)|^\s*(can|could|would|will|do|does|did|is|are|should|shall|what|when|where|who|why|how|any update)\b/im,
  request: /\b(please|pls|can you|could you|would you|will you|need you to|kindly|let me know|lmk|your (input|thoughts|feedback|review|help)|review (this|the)|take a look|action (required|needed)|waiting (on|for) you|need your)\b/i,
  approval: /\b(approv(e|al|ed|ing)|sign[- ]?off|go\s*\/\s*no[- ]?go|green[- ]?light|authori[sz]e)\b/i,
  decision: /\b(decide|decision|which option|option [a-c1-3]\b|should we|prioriti[sz]e|trade-?off|your call|confirm (whether|if))\b/i,
  urgent: /\b(urgent|asap|immediately|critical|blocker|blocking|outage|prod(uction)? (is )?(down|issue|incident|outage)|p1|sev ?-?1|escalat\w*|hotfix|emergency)\b/i,
  release: /\b(release|deploy(ment|ing)?|roll ?out|roll ?back|go[- ]live|cut ?over|hotfix|code freeze|go\s*\/\s*no[- ]?go|regression)\b/i,
  commitment: /\b(i('ll| will| shall)|i am going to|i'm going to|let me (check|look|get back|follow up|find out|confirm)|will (send|share|get back|follow up|update|review|provide|confirm|circle back))\b/i,
};

export function detectIntents(text = '') {
  const t = text.slice(0, 4000);
  return {
    question: RX.question.test(t),
    request: RX.request.test(t),
    approval: RX.approval.test(t),
    decision: RX.decision.test(t),
    urgent: RX.urgent.test(t),
    release: RX.release.test(t),
    commitment: RX.commitment.test(t),
  };
}

// Jira keys like REST-21533. Deduplicated, in order of appearance.
export function extractJiraKeys(text = '') {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g) ?? [])];
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

export function htmlToText(html = '') {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export const truncate = (s = '', n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DEADLINE = new RegExp(
  '\\b(?:by|before|due|until|no later than|deadline(?: is)?:?)\\s+(?:the\\s+)?(' +
  'eod|cob|end of (?:the )?day|today|tonight|tomorrow|eow|end of (?:the )?week|next week|' +
  '(?:mon|tues|wednes|thurs|fri|satur|sun)day|' +
  '\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|' +
  '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?' +
  ')\\b', 'i',
);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Finds a deadline phrase and resolves it to a local date (YYYY-MM-DD) relative to `ref`.
export function parseDeadline(text = '', ref = new Date()) {
  const m = text.match(DEADLINE);
  if (!m) return null;
  const p = m[1].toLowerCase().replace(/\s+/g, ' ');
  const base = new Date(ref);

  if (['eod', 'cob', 'end of day', 'end of the day', 'today', 'tonight'].includes(p)) return { phrase: m[0], date: ymd(base) };
  if (p === 'tomorrow') return { phrase: m[0], date: ymd(addDays(base, 1)) };
  if (['eow', 'end of week', 'end of the week'].includes(p)) return { phrase: m[0], date: ymd(addDays(base, (5 - base.getDay() + 7) % 7)) };
  if (p === 'next week') return { phrase: m[0], date: ymd(addDays(base, ((1 - base.getDay() + 7) % 7) || 7)) };

  const wd = WEEKDAYS.indexOf(p);
  if (wd >= 0) return { phrase: m[0], date: ymd(addDays(base, ((wd - base.getDay() + 7) % 7) || 7)) };

  let month, day, year = base.getFullYear();
  const slash = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    [month, day] = [Number(slash[1]) - 1, Number(slash[2])];
    if (slash[3]) year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
  } else {
    const named = p.match(/^([a-z]+)\.?\s+(\d{1,2})/);
    month = MONTHS.indexOf(named[1].slice(0, 3));
    day = Number(named[2]);
  }
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let date = new Date(year, month, day);
  if (!slash?.[3] && date < addDays(base, -30)) date = new Date(year + 1, month, day); // "Jan 5" written in December
  return { phrase: m[0], date: ymd(date) };
}

export const ageDays = (iso, now = new Date()) => (now - Date.parse(iso)) / 86_400_000;
