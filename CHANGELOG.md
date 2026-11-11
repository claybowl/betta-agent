# Changelog

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
