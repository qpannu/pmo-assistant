---
name: feedback_scrum_report_restaurant_sprints
description: The Scrum report shows only tickets in sprints whose name starts with "Restaurant" (board 1946 also runs RA 2.0, KDS V2, Ops Integrations sprints)
metadata:
  type: feedback
---

On Oct 30, 2026, after the first Scrum report covered all four active sprints on board 1946 (Restaurant 2026 Q4.3, RA 2.0, KDS V2, Ops Integrations), the user said: "one need to show the tickets in sprint that start with keyword 'Restaurant'".

**Why:** The Restaurant sprint is the team's main sprint; the other parallel sprints on the same board are noise for this report.
**How to apply:** Scope the Scrum report to sprints whose name starts with "Restaurant" — via the `REPORT_SPRINT_PREFIX=Restaurant` setting, not a hardcoded name, so it follows each new sprint (Q4.4, 2027 Q1.1…). Other sprints only when explicitly asked (`--sprint`). Related: [[feedback_morning_briefing_format]].
