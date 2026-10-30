---
name: feedback_save_corrections_as_memory
description: Every correction from the user is saved as its own .md file in the project's memory/ folder and indexed in memory/MEMORY.md
metadata:
  type: feedback
---

Whenever the user corrects me, save the correction as its own Markdown file in `memory/` inside the PMO Assistant project folder, named with a prefix: `feedback_`, `user_`, `project_` or `reference_`. Add a one-line entry for it in `memory/MEMORY.md`.

**Why:** The user wants corrections kept with the project, visible and reviewable, not only in the assistant's private memory (stated Oct 30, 2026).
**How to apply:** One fact per file with frontmatter (name, description, type) and Why / How to apply lines. Update an existing file instead of duplicating it. Never put secrets in these files. Related: [[feedback_morning_briefing_format]].
