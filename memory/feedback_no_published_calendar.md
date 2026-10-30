---
name: feedback_no_published_calendar
description: Don't ask me to publish/share my Outlook calendar (ICS link); post the morning summary built the way the chat "my day" summary was, from the Microsoft 365 connector
metadata:
  type: feedback
---

On Oct 30, 2026 I proposed publishing the Outlook calendar as an ICS link so the service could read it. The user said: "i dont want to do the shared calendar thing. i need you to post the calendar message just like you posted on the chat above".

**Why:** Publishing the calendar is an extra sharing step the user doesn't want; the chat summary already showed the calendar via Claude's Microsoft 365 connector, so they expect the Teams post to come from the same source.
**How to apply:** Never ask the user to publish or share their calendar. Build the Teams morning summary inside a Claude session with the Microsoft 365 connector (calendar, mail, Teams chats) plus Jira, then post it to the Teams webhook via `npm run teams:post`. The ICS code path stays in the repo but is unused. Supersedes the ICS advice in [[feedback_briefing_must_include_calendar]]; format per [[feedback_morning_briefing_format]].
