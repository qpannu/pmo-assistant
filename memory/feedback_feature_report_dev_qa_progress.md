---
name: feedback_feature_report_dev_qa_progress
description: Feature report must show, per initiative, overall health + dev progress + QA progress, with an estimated timeline from DEV Hours / QA Hours; Assigned Developer / Assigned QA are FYI only
metadata:
  type: feedback
---

On Oct 30, 2026, reviewing the first Feature report, the user said: "for each initiative, i need overall health, dev progress and qa progress. there are dev hrs and qa hrs in each ticket which can help formulate an estimated timeline. also assigned dev and assigned qa fields holds the person responsible for the ticket. this is fyi and no action needed on dev and qa assigned."

Verified fields on madmobile-eng (found by name, not hardcoded): DEV Hours (customfield_11309), QA Hours (customfield_11310), Assigned Developer (customfield_10060), Assigned QA (customfield_10061). "Completed Dev/QA Hours" exist but are rarely filled (71 / 23 of 300), so progress comes from status, weighted by the estimated hours.

**Why:** Ticket counts alone hide where work is stuck; dev vs QA progress and remaining hours per person show whether a feature can land and when.
**How to apply:** Per initiative show overall health, dev progress (dev-complete = Ready for QA or later), QA progress (QA-complete = past the QA columns or done), remaining hours, and an estimated finish from remaining hours per assigned person ÷ hours per day — labelled as an inference, with what it excludes. Show Assigned Developer / Assigned QA names as information only: no follow-ups or risks about who is assigned. Related: [[feedback_scrum_report_restaurant_sprints]], [[feedback_release_report_tracked_prefixes]].
