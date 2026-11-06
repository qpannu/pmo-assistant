---
name: project_qa_progress_report
description: Agreed design for the separate QA Progress report (POS initiatives + ezCater, QA owners, status-based signoff); sample sent Nov 5, not built yet
metadata:
  type: project
---

Agreed Nov 5, 2026: a new, separate on-demand chat report (planned `npm run qa`, `src/reports/qa.js`) beside the existing four; existing reports unchanged. An HTML dashboard with graphs/trends comes later.

- Initiatives: Tips Hardening REST-17306; Tip Reporting + BBBA = REST-17969 (one initiative); Delivery Tax Exempt REST-18147; ezCater uses the war-room snapshot.
- QA owners (user-confirmed source of truth): Darren = Tip Reporting/BBBA + Tax Exempt; Kaelon = Tips Hardening; Brew = ezCater.
- QA signoff is status-based (Review or Accepted). Stale in-QA threshold = 3 days. Health RAG rated by Claude from the data.
- Six sections: overall health, POS features, ezCater, QA ownership, risks, release alignment (by fix version; see [[feedback_pos_744_merged_into_746]]).
- Mark test pass/fail counts, pending scenarios and retests "QA to confirm"; Jira "updated" is distorted by Oct 28 bulk edit, use the change log.
- Combined E2E report starts week of Nov 16+; keep per-feature health visible.
Related: [[feedback_dev_qa_status_rules]], [[feedback_feature_report_dev_qa_progress]].
