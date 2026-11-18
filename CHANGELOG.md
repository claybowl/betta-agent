# Changelog

## Unreleased

- Add `network`, `browser` and `desktop` permissions. `network` exposes `http_request` (HTTP(S), headers, body, `bearerEnv` credential references, bounded output, no redirect following) without enabling the shell; `browser` and `desktop` expose `agent_browser` / `agent_desktop`, which run the Vercel CLIs with an argument array and no shell.
- Every run gets a live host capability report, and the agent can refresh it with the `capabilities` tool. `/tools` shows the same report.
- `/connections` gets an arrow-key menu, a remote URL shortcut and a "Connect my Chrome with browse" preset.
- Add `/prompt` to view, edit or import an agent's base system instructions.
- Bundle the `betta-agent` operating brief and the agent-browser / agent-desktop discovery skills; the brief loads on every run.
- Core memory over 15% of the model's context now warns instead of failing; runs refuse only above 40%.
- `http_request` action history records only method and URL origin+path.

## 0.5.0 — 2026-11-16

- Bigger startup banner: BETTA AGENTS in a heavy, wide block face on terminals 76 columns or wider, revealed with a short slanted wipe and glint. Set `DONJON_NO_MOTION=1` to skip the animation; narrower terminals keep the earlier wordmark.
- Add `/login` and `/logout`: paste a provider API key once (hidden as you type) or sign in with a ChatGPT subscription; logins are saved owner-only in `~/.donjon/credentials.json`, so keys no longer have to be exported in every shell. Claude Pro/Max sign-in is not offered because Anthropic's terms reserve it for Claude Code and claude.ai.
- Add `/goal [--rounds N] [--budget USD] OBJECTIVE`: the agent keeps taking turns until it reports done or blocked, or the turn or spend limit (default 8 turns, $2) stops it. Esc stops the loop.
- `/model` no longer saves a model it cannot find: typed refs are checked against the catalog (split on the first slash only, so `nvidia/nvidia/nemotron-…` is valid), unknown refs are refused with "did you mean" suggestions, and a missing provider key is called out before the first run.
- The model picker lists providers that have no key in the current shell, marked `needs <ENV_VAR>` and ordered after configured ones (OpenCode, Z.ai, OpenRouter and NVIDIA lead the keyless list); free models are tagged.
- A saved model that cannot run is reported at startup and after switching agents, and "Provider is not configured" run failures name the variable to export.
- Rebrand the chat interface as Betta Agents with a new wordmark and the Magic City theme (gold, flamingo, teal). Donjon purple and plain remain under `/theme`. Application settings saved before this change move from purple to Magic City once.
- Typing `/` on an interactive terminal opens a command palette with arrow-key selection, filtering, Tab completion and Enter to run.
- Add `/model`: a filterable picker that lists the runtime catalog for providers with credentials and marks models live as each provider's API answers. Models the provider offers but the runtime catalog lacks are shown and cannot be selected.
- Replace the typed menus for agents, skills, permissions, runtime, theme and settings with arrow-key pickers. `/new` suggests a home under the config directory and picks the model from the same list. Scripted (piped) chat is unchanged.
- Show a spinner with elapsed time and the current tool while a turn runs.
- Skills: read frontmatter properly (folded and multi-line descriptions, quoted values), accept `skill.md` in any letter case, and report skipped folders with the reason.

## 0.4.0 — 2026-11-15

- Add an optional Doer integration, active only when `DOER_API_URL`, `DOER_API_KEY`, `DOER_COMPANY_ID` and `DOER_AGENT_ID` are all set. Standalone behavior is unchanged without them.
- Run as a Doer agent through Doer's built-in `process` adapter (`donjon-agent run HOME PROMPT`), with no changes to Doer. See DOER.md for setup and the standing heartbeat prompt.
- Under Doer, use the heartbeat run ID as the request ID, read the run's wake context, and do not resume work that belonged to a run Doer cancelled. `run` and `resume` honor Doer's stop signal on macOS and Linux.
- Add `doer_approval_*` tools backed by Doer's approvals (no local approval list, no approve/reject tool) and a small set of `doer_issue_*` tools. Each run checks this agent's rejected and returned approvals.
- Report the agent's own token usage and cost to Doer after each run, best effort.
- Remove known credentials from tool arguments written to the action journal.
- Unfinished work now saves additional non-secret wake variables. State written by 0.3.0 is read unchanged; no migration.
- Brand the terminal as DIS Betta Agents with a fish banner and a compatible betta-agents executable alias.
- Add model and inference provider controls through /model and Settings.


## 0.3.0 — 2026-11-11

- Add ASCII memory maps with outgoing Markdown/wiki links and backlinks.
- Add optional local historical archive retrieval through history_search and history_read.


- Complete the MemFS upgrade: immutable committed core context, deferred indexes, automatic migration, configurable validation, and recoverable multi-file learning transactions.
- Add agent-scoped conversation recall, memory search with provenance, and committed memory skills with legacy precedence.
- Add bounded reflection proposals, preview/apply/retry, conflict retention, source-window deduplication, and a headless command for Doer routines.
- Add memory settings/controls, history and revert, explicit remote sync, Git bundles and history-preserving exports/imports.
- Preserve existing execution recovery and request deduplication. Existing agent homes migrate on first run; previous memory revisions remain in Git.

## 0.2.0 — 2026-11-11


- Add themed terminal chat, ASCII startup banner, slash-command completion, and settings screens.
- Stream shell commands/output; Escape cancels the current turn. Persist action receipts and show unknown outcomes after interruption.
- Add per-agent working directory, permissions, model, turn limit, compaction, and timeout controls; add application theme/banner settings.
- Add MCP stdio and Streamable HTTP clients with connection status, environment-referenced credentials, tool discovery, cancellation, and conservative replay behavior.
- Add agent discovery/switching/creation and skill catalogs, instruction inspection, explicit skill requests, and loading evidence.
- Existing homes require no migration. Optional settings override legacy allowShell; worker overrides retain precedence. Exports include settings with connections disabled; continuation exports include action receipts.


## 0.1.0 — 2026-11-11

- Establish the standalone harness repository, extracted from the Doer prototype with source history preserved.
- Portable agent homes, Markdown memory, local Git history, and SQLite execution recovery.
- Terminal chat, request deduplication, cancellation, and agent-copy/continuation exports.
- Automated tests, independent package-install checks, pinned dependencies, and GitHub release archives with SHA-256 checksums.
