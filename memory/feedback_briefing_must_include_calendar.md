---
name: feedback_briefing_must_include_calendar
description: The Teams briefing must show my calendar; "Not available" is not acceptable when the data exists — find a source that works without waiting on IT
metadata:
  type: feedback
---

The Oct 30 Teams briefing said "Calendar — Not available: Outlook calendar not connected" while the chat summary above it listed my meetings. The user asked why and said "fix it".

**Why:** The chat summary used Claude's own Microsoft 365 connector (only available inside a Claude session); the background service had no calendar access because the Entra app (Graph) is still pending with IT. From the user's side, the assistant "knew" the calendar but the briefing didn't — that inconsistency is the problem, not the honest label.
**How to apply:** Don't stop at "not available" when there is a workable path. For the calendar, use the Microsoft 365 connector in a Claude session (the user declined publishing an ICS link — see [[feedback_no_published_calendar]]); prefer Graph once IT grants it. When something truly can't be connected, say exactly what the user can do to connect it. Related: [[feedback_morning_briefing_format]].
