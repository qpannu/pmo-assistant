---
name: project_weekly_plan_routine
description: Monday 1 PM ET cloud routine that reminds Qaiser to send the "Restaurant Weekly Plan" email and posts an updated draft to his Teams Workflows chat
metadata:
  type: project
---

Since Nov 2, 2026, Qaiser sends a **"Restaurant Weekly Plan – Week of <date>"** email every Monday after the PMO's leadership meeting (To technology@, CC pmo_restaurant@ and Chathura). Sections: Fixed POS (per release), KDS Fixes, CakePop, OLOv2, Key Focus Areas, Ongoing and Next Priorities (per person).

On Nov 3, 2026 he asked for a Monday 1 PM reminder plus a draft with updates. Set up as:
- **Routine:** "PMO Weekly Plan reminder + draft → Teams (Mondays 1 PM ET)", id `trig_01KLCG4cM3Mp7B3GEHAttA4n`. Cron `30 17 * * 1` UTC (12:30 PM EST, lands ~1 PM). **DST:** change to `30 16 * * 1` from Mar 14, 2027.
- **Prompt source:** `cloud/pmo-weekly-plan-prompt.md`.
- It uses the newest sent "Restaurant Weekly Plan" email as the template, then updates each item from Jira, Confluence, mail and Teams. Unconfirmed items are marked [confirm]. It adds a "[Add priorities from today's leadership meeting]" placeholder, because transcripts are blocked by the tenant. It goes through the QA gate at 95.
- **Draft only:** it posts to Teams and never creates or sends email (the M365 connector is read-only anyway).

Related: [[project_cloud_morning_routine]], [[project_pmo_agent_team]].
