---
name: project_ezcater_war_room_exec_summary
description: ezCater war room (Nov 4-13, 2026): the daily executive-summary email format Qaiser wants every end of day, plus plan dates, definitions and the standing Note
metadata:
  type: project
---

The ezCater war room started Wed Nov 4, 2026 (Day 1). Plan: dev done EOD Fri Nov 6; ticket testing done by end of next week (Fri Nov 13); end-to-end/regression starts the week of 11/16 (Mon 11/16). Qaiser sends an end-of-day **executive summary email** (posted to his Teams chat at **3 PM ET**, changed from 5 PM on Nov 5; the SOD note posts at 8 AM ET) to Zubair (and the team/management) every day through Nov 13. On Nov 4 he sent this exact format; he asked on Nov 4 to get it **every day**.

**Format (email draft, Qaiser sends it himself):**
- "Hi Zubair," then "Here is the executive summary of the progress made during Day N of the war room."
- **Total Ticket Count: Open X (Y this morning).** Sub-bullets: Dev N (M this morning), with n Critical and n High. QA N (M this morning).
- **Progress today:** (bold) bullets: "N tickets passed QA:" linked keys; "N moved to Building (Dev testing):" keys; "N new issue(s) reported"; "Nothing is Blocked at the moment." (or name the blocked tickets).
- "Here is the breakdown of N open tickets by status": bold status with count and linked keys, in this order: Ready for Development, Dev in Progress, Code Review, Building / Dev testing, Blocked / On Hold. Mark Critical tickets "(Critical)".
- "I will continue sending these end-of-day summaries through the end of next week to keep everyone updated on progress." (final day Nov 13: say this is the final one.)
- **Note:** (standing, keep until Qaiser changes it) "I have asked Brew to pause regression testing and focus on ticket validation for the time being. As a result, he will not be sending end-of-day regression testing updates this week or next week. The plan is to begin end-to-end testing during the week of 11/16. The scope will also include additional POS features currently being developed by Team Tesla."
- "Please let me know if you have any questions." / "Thanks" / "Qaiser" / signature: Qaiser Pannu, Sr. Program Manager, M: 813-990-7900, www.trycake.com, Mad Mobile | CAKE.

**Counting rules (Day 1, confirmed by Qaiser):** Scope = ezCater epics 214734, 214736, 214738, 214740, 228301, 229224, 236241, 245356, 256765, `hierarchyLevel != -1` (no sub-tasks), statuses Open, Dev in Progress, Ready for Development, Code Review, Ready for QA, Blocked, On Hold, Building, QA in Progress. "Passed QA" = moved today to Review or Accepted (Day 1: 4 Review + 2 Accepted = 6). "Moved to Building" = in Building now and moved there today. "New issue" = created today in those epics.
Day 1 numbers (Nov 4, end of day): open 27 (31 morning); Dev 18 (21), 2 Critical, 10 High; QA 9 (10); 6 passed QA; 6 moved to Building; 1 new issue (REST-21582); nothing blocked.

**Why:** Management (Zubair) gets one consistent daily read on war-room progress.
**How to apply:** Build the EOD post in this format; see the cloud routine "ezCater war-room SOD + EOD snapshots" (trig_019Auc6xLhtq5coUDSvJCYbA). Never send it; draft only. Related: [[feedback_dev_qa_status_rules]], [[project_cloud_morning_routine]].

**Schedule change (Nov 5, 2026):** EOD summary only at 3 PM ET (routine starts 2:30 PM ET); the 5 PM run was removed. Cron `30 12,19 5-6,9-13 11 *` on trig_019Auc6xLhtq5coUDSvJCYbA. The one-time Nov 4 3 PM routine (trig_01YUhyYW2ubSdNuCBcyx2Vif) is disabled. Nov 4 3 PM snapshot (as of 2:30 PM ET): ALL 27 / DEV 18 / QA 9.
