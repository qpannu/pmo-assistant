---
name: project_cloud_morning_routine
description: The weekday 7 AM ET Morning Brief runs as an Anthropic cloud routine (not the laptop) — id, schedule, scope (5 initiatives + tracked releases), short one-message format, secrets, DST caveat
metadata:
  type: project
---

On Oct 30, 2026 the user asked for the morning summary to run on Anthropic's cloud instead of the laptop, posting to the Teams webhook.

- **Routine:** "PMO Morning Brief → Teams (weekdays 7 AM ET)" (renamed Nov 3, 2026), id `trig_01DijpoL9J9ErHUdDWaAkv9y`, https://claude.ai/code/routines/trig_01DijpoL9J9ErHUdDWaAkv9y
- **Cron:** `30 11 * * 1-5` UTC = starts 6:30 AM EST so the post lands ~7:00 (runs take ~25–30 min; Qaiser asked on Nov 3, 2026 for 7 AM because it was arriving ~8:05). **DST caveat:** from Mar 14, 2027 change to `30 10 * * 1-5`, and back in November.
- **v2 (Nov 1, 2026, user-approved):**
  - Sections: ⚠️ Escalations at the top, then Meetings with 2–3 cited prep points each, Top 3, 📧 Reply today (email), Waiting on you, 🎯 Initiatives, 🚀 Releases, ⏰ Overdue/blocked, 🆕 New since yesterday, Suggested order.
  - **Initiatives:** per tracked initiative, not just ezCater: REST-247, REST-17306, REST-17969, REST-18147, REST-17834. These are inlined in the prompt, so when `npm run features` changes, update the prompt and the routine too.
  - **Releases:** only those with the prefixes POS_7, MPOS_, KIOSK_ and CCL_8.
  - **Length (Nov 3, 2026, Qaiser: "make the note … bit brief"):** one message, ≤3,000 chars, one-line bullets; sections Escalations, Meetings (1 prep point only for his/initiative meetings), Top 3, Waiting on you (≤5), Initiatives (1 line each), Releases (overdue/due 7 days/blocked, ≤5), Order. Split into two only if escalations alone overflow.
- **Prompt:** self-contained and kept in `cloud/pmo-morning-routine-prompt.md`. Edit that file and update the routine together.
  - The cloud can't see `~/.claude/agents`, skills or this repo (no git remote), so the agent briefs are inlined.
  - Flow: Opus triage, delivery and release analysts → planner → Opus QA gate (95, max 3 rounds, then post labelled "Did not pass QA (n/100)", as the user chose) → Python POST to the webhook.
- **Connectors attached:** Microsoft_365, Atlassian_MCP / Atlassian (plus Claude_Docs, Claude_Code_Remote).
- **Webhook secret:** read from the cloud environment variable `TEAMS_WEBHOOK_URL`. The user sets it themselves in the environment settings and never pastes it into chat.
- **Laptop task** `pmo-morning-summary` is paused, and the Node service's morning briefing is off (`BRIEFING_MORNING=`).

**Why:** The user wants the summary to arrive whether or not the laptop is on.

**How to apply:** Make changes to the morning summary in the cloud prompt file and the routine (RemoteTrigger update), not in the paused local task. Debug with `list_runs` / `get_run_log`. Related: [[project_pmo_agent_team]], [[feedback_morning_briefing_format]].


**Nov 5, 2026 update:** the brief now **excludes ezCater** entirely (the war room has its own SOD/EOD posts), and the Releases section is **by product**: POS (`POS_7`), Cake Pop (`MPOS_`), KIOSK (`KIOSK_`), Cloud (`CCL_8.`) — the 5 most recent (highest-version) unreleased versions each, with 🟢/🟡/🔴 risk flags and reasons (overdue, due soon with tickets not in QA, blockers, cross-release dependencies, owner PTO, failed QA). Length target raised to ≤4,800 chars; split into 2 messages above 3,000 (Part 2 starts at Initiatives). 🔴 releases due within 48 h also go in Escalations. Prompt source: cloud/pmo-morning-routine-prompt.md.
