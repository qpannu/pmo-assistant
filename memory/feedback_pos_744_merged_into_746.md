---
name: feedback_pos_744_merged_into_746
description: POS 7.44 was merged into 7.46; never reference 7.44 in reports, count its tickets under POS 7.46
metadata:
  type: feedback
---

On Nov 5, 2026 the user said: "7.44 pos release was merged into 7.46 so we dont need to reference 7.44 anywhere."

**Why:** There is no separate 7.44 track anymore; showing it confuses release alignment.
**How to apply:** In QA, release and morning-brief outputs, fold tickets with POS_7.44.x fix versions (e.g. POS_7.44.0.19, POS_7.44.2.15) into the POS 7.46 track and don't mention 7.44. Related: [[project_qa_progress_report]], [[feedback_release_report_tracked_prefixes]].
