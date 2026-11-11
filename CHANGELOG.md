# Changelog

## Unreleased

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
