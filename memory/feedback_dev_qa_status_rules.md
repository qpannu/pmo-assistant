---
name: feedback_dev_qa_status_rules
description: Which ticket statuses mean dev not complete / QA in progress / QA done, and how to classify Blocked and On Hold from the change log (who moved it there)
metadata:
  type: feedback
---

On Oct 30, 2026 the user defined the status rules for dev and QA progress:

- **Not dev-complete:** Open, Product Planned, Ready for Dev(elopment), Dev in Progress, Code Review, Building.
- **QA in progress (dev-complete):** Ready for QA, QA in Progress.
- **QA done:** anything past that (Review, Pending Merchant Review, Accepted, Closed, Done).
- **Blocked / On Hold:** "it depends who moved the ticket to this status. if you look at change log then you will be able to see if dev or qa moved the ticket into this status."

**Why:** A blocked ticket found in QA has finished development; one blocked by a developer hasn't. Treating every blocked ticket alike skews dev and QA progress.
**How to apply:** For Blocked/On Hold tickets read the Jira change log, find who made the latest move into that status, and compare with the ticket's Assigned Developer / Assigned QA. If the QA moved it, it counts as dev-complete and QA in progress; if the developer moved it, it counts as not dev-complete. If neither person moved it, use the status it came from. With no change-log entry, count it as not dev-complete and say why. Say in the report which rule decided each blocked ticket. Related: [[feedback_feature_report_dev_qa_progress]].
