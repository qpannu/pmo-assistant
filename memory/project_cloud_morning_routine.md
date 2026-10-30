---
name: project_cloud_morning_routine
description: The weekday 7 AM ET morning summary runs as an Anthropic cloud routine (not the laptop) — id, schedule, secrets, DST caveat
metadata:
  type: project
---

On Oct 30, 2026 the user asked for the morning summary to run on Anthropic's cloud instead of the laptop, posting to the Teams webhook.

- **Routine:** "PMO morning summary → Teams (weekdays 7 AM ET)", id `trig_01DijpoL9J9ErHUdDWaAkv9y`, https://claude.ai/code/routines/trig_01DijpoL9J9ErHUdDWaAkv9y
- **Cron:** `0 12 * * 1-5` UTC, which is 7:00 AM EST. **DST caveat:** after Mar 14, 2027 this becomes 8:00 AM EDT. Change it to `0 11 * * 1-5` then, and back in November.
- **Prompt:** self-contained and kept in `cloud/pmo-morning-routine-prompt.md`. Edit that file and update the routine together.
  - The cloud can't see `~/.claude/agents`, skills or this repo (no git remote), so the agent briefs are inlined.
  - Flow: Opus triage, delivery and release analysts → planner → Opus QA gate (95, max 3 rounds, then post labelled "Did not pass QA (n/100)", as the user chose) → Python POST to the webhook.
- **Connectors attached:** Microsoft_365, Atlassian_MCP / Atlassian (plus Claude_Docs, Claude_Code_Remote).
- **Webhook secret:** read from the cloud environment variable `TEAMS_WEBHOOK_URL`. The user sets it themselves in the environment settings and never pastes it into chat.
- **Laptop task** `pmo-morning-summary` is paused, and the Node service's morning briefing is off (`BRIEFING_MORNING=`).

**Why:** The user wants the summary to arrive whether or not the laptop is on.

**How to apply:** Make changes to the morning summary in the cloud prompt file and the routine (RemoteTrigger update), not in the paused local task. Debug with `list_runs` / `get_run_log`. Related: [[project_pmo_agent_team]], [[feedback_morning_briefing_format]].
