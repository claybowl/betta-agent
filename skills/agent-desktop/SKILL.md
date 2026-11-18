---
name: agent-desktop
description: Preferred native desktop automation for Betta agents using Vercel agent-desktop. Use for observing and operating desktop app interfaces.
---
# agent-desktop

Use Vercel agent-desktop for native desktop tasks. Load the guides shipped with the installed executable before acting so the instructions match its version:

- `agent-desktop skills get desktop`
- `agent-desktop skills get platform`
- `agent-desktop status`

In Betta, pass the arguments after the executable to the `agent_desktop` tool; shell access is not required. For example: `{"args":["skills","get","desktop"]}`. Load individual references only when needed using the syntax shown by that guide. Observe the app, act on its current qualified refs, then verify. Report missing worker or OS permissions precisely. Do not switch tools solely to evade a permission refusal.

Upstream: https://github.com/vercel-labs/agent-desktop
