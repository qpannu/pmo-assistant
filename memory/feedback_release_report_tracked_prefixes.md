---
name: feedback_release_report_tracked_prefixes
description: The Release report covers only Fix Versions starting with the prefixes Qaiser tracks — POS_7, MPOS_, KIOSK_, CCL_8. (set in REPORT_RELEASE_PREFIXES)
metadata:
  type: feedback
---

On Oct 30, 2026, after the first Release report listed all 65 unreleased versions with Tesla board work (incl. Madpay, OLO, RA, CAKE NEO, EMS…), the user said: "the current releases i am tracking have pre-fix of 'POS_7', 'POS_7', 'MPOS_', 'KIOS_', 'CCL_8.'".

**Why:** Only those product lines are the releases they manage; the rest is noise.
**How to apply:** Scope the Release report with `REPORT_RELEASE_PREFIXES=POS_7,MPOS_,KIOSK_,CCL_8.` (case-insensitive "starts with"), not hardcoded names. The user typed "KIOS_", but Jira's kiosk versions are named "KIOSK_…" (e.g. KIOSK_1.3.29), so the setting uses KIOSK_ — confirm if they meant something else. Mention how many other versions were left out so nothing silently disappears. Related: [[feedback_scrum_report_restaurant_sprints]].
