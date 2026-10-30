---
name: feedback_morning_briefing_format
description: The 7:00 AM Teams briefing must look like the Oct 30 "tell me about my day" summary — calendar, top 3, waiting on you, moving without you, suggested order
metadata:
  type: feedback
---

The weekday 7:00 AM ET Teams briefing should follow the shape of the Oct 30, 2026 "tell me about my day" summary (user: "this is the kind of summary I need on Teams every morning").

Structure, in order:
1. **Calendar** — each meeting with time (ET), title, whether I organize, who accepted; blocked appointments; the free windows between them; who is out (PTO/OOO).
2. **Top 3 today** — each with what changed since yesterday (e.g. "REST-21533 moved to Code Review last night"), the decisions I owe, and how it ties to today's meetings (e.g. "prep for the 11:00 ezCater touchpoint").
3. **Still waiting on you** — person → what they need, oldest first; say when replies weren't checked.
4. **Moving without you** — progress others made since the last briefing (status changes, PRs), so I know what not to chase.
5. **Suggested order** — one or two lines mapping the work onto today's free windows.

**Why:** It reads like a chief of staff: calendar-aware, says what changed, and tells me what to do in which gap — the generic 8-section briefing was less useful.
**How to apply:** Keep bullets (Teams Adaptive Cards don't render tables), link tickets/messages, report missing data instead of guessing. Calendar, free windows and Teams/Outlook items need Microsoft Graph (Entra app); the people-and-message synthesis needs Claude enabled. Related: [[feedback_save_corrections_as_memory]].
