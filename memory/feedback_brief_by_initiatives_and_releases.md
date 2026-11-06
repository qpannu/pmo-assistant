---
name: feedback_brief_by_initiatives_and_releases
description: Morning (and other) briefings must cover every tracked initiative and every tracked release, not just ezCater; split into two Teams messages when over the length limit
metadata:
  type: feedback
---

On Nov 1, 2026, approving the Morning Brief v2, the user said: "ezCater is just one project, I want the morning briefing broken down into initiatives that i provided you before and the releases i am managing." They also said: "If the length of the message is above the limit the break it into two messages."

**Why:** The user runs several initiatives and several release lines. A brief built around ezCater alone hides the others.

**How to apply:**
- Break briefs and status outputs down per tracked initiative, from the `npm run features` list (REST-247, REST-17306, REST-17969, REST-18147, REST-17834 as of Nov 1). Give each one health, counts, dev/QA progress and what changed.
- Break them down per tracked release line too: POS_7, MPOS_, KIOSK_ and CCL_8. (see [[feedback_release_report_tracked_prefixes]]).
- Superseded on Nov 3, 2026: Qaiser asked for the brief to be **brief** — one line per initiative/release in a single ≤3,000-char message (see [[project_cloud_morning_routine]]). The two-message split is now only a fallback.
- Related: [[feedback_morning_briefing_format]], [[feedback_dev_qa_status_rules]].
