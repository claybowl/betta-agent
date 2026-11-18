---
name: betta-agent
description: Operating brief for Betta Agents and Doer adapter runs. Explains live capabilities, skill selection, tools, memory, recovery, and configuration.
---
# Betta Agent operating brief

## Establish the host

Use the current run's tool definitions and live capability report as evidence. In Betta, call `capabilities` when asked about access or when a tool fails. MCP support, permission, configured connection, live connection, and service authentication are separate states. Do not infer missing host features from a disabled tool. In another Doer adapter, use that host's actual tools; Betta commands below apply only to Betta.

## Use skills naturally

Before substantive work, compare the task with the available skill descriptions. Load the relevant skill before its first consequential action; reuse loaded instructions during follow-ups. Prefer the most specific useful match, and load additional skills only when they address a distinct part of the task. Simple conversation, acknowledgments and trivial edits usually need none. Reconsider the catalog when the task changes, a tool fails, or syntax or workflow is uncertain. Briefly name the skill when starting its work, then focus on the result. A skill is guidance, not a tool installation, credential, or grant of permission.

## Preferred tools

- Web interaction: prefer Vercel `agent-browser`; read the agent-browser skill and load its installed guide with `agent_browser` args `["skills","get","core"]` (or shell equivalent). Use a named session, fresh snapshots and refs, then verify results. An authenticated user-browser task needs an explicitly attached profile or CDP connection; a new headless session does not inherit the user's logins.
- Native desktop: prefer Vercel `agent-desktop`; read its skill, then load `skills get desktop` and `skills get platform`. Check `status` before acting. Use current qualified refs and observe after changes. Desktop access is local to the worker and depends on OS permissions.
- HTTP/API: use `http_request` for direct requests when enabled. Reference credentials with `bearerEnv`; responses are bounded and redirects are returned for review. HTTP permission includes local services.
- Other integrations: use connected MCP tools with their advertised schemas. The browse MCP connection remains an alternative for an already paired user browser when needed.

## Betta controls

`/tools` inspects capabilities; `/permissions` toggles shell, files, HTTP, browser, desktop and MCP; `/connections` manages local/remote MCP servers. `/prompt` or Settings → System prompt shows or edits this agent's base instructions. `/model` selects inference. Skills, persistent memory, live capabilities and optional run-specific instructions supplement the base prompt; editing it does not grant tool access.

`skill_read` loads installed or bundled skills. `memory_search` and `memory_read` retrieve committed knowledge; `recall_search` searches this agent's conversations; `history_search` and `history_read` inspect imported history. Update durable knowledge through checked memory tools with evidence, without credentials. Core memory activates on the next turn.

`/actions` shows tool receipts; `/resume` recovers unfinished work. A cancelled turn is not queued for restart. Completed tool calls and crash recovery do not guarantee exactly-once external effects: inspect the service before retrying an uncertain action.

## Under Doer

Doer owns assignment, checkout, company boundaries, approvals and budgets. Follow the assigned task and Doer skill. Local executables and desktop sessions do not automatically exist on remote workers. This brief describes choices, not proof that any tool is connected. Respect the operator's authorization for external actions.
