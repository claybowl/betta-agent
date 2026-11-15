# Donjon Agent

A local agent harness built on Pi Durable. Agent identity and Markdown memory persist across conversations; execution checkpoints allow interrupted work to recover after a process crash.

## Start

Requires Node **22.19+**, Git, and an available model (Ollama locally or a provider API key).

```sh
npm ci --ignore-scripts
npm run build
./donjon-agent chat "$HOME/.donjon/agents/dondog"
```

Existing DonDog homes work directly. To create another agent:

```sh
./donjon-agent init "$HOME/.donjon/agents/my-agent" 'My Agent' ollama/qwen3.5:9b
./donjon-agent chat "$HOME/.donjon/agents/my-agent"
```

Use an Ollama model installed on your machine. Ollama defaults to localhost:11434/v1; override OLLAMA_BASE_URL if needed. For other providers set their API key in your environment and choose provider/model-id. Credentials remain outside the manifest.

## Commands

```text
init HOME NAME PROVIDER/MODEL
chat HOME                         interactive slash-command interface
run HOME PROMPT [REQUEST_ID]
resume HOME
inspect HOME
export HOME NEW_DIRECTORY
export HOME NEW_DIRECTORY --continuation
```

Chat has a purple/grey theme, a startup banner, Tab completion, live command output, and settings screens. `NO_COLOR=1` or the plain theme disables colors. Escape (or Ctrl-C during a run) stops the whole current turn, including its running command; it does not undo effects. Ctrl-C at the input prompt exits.

| Slash command | Purpose |
| --- | --- |
| `/settings` | Browse settings sections |
| `/permissions` | Toggle shell, file write/edit, and MCP access |
| `/runtime` | Model, maximum turns, compaction, run timeout |
| `/cwd [PATH]` | Persist the agent's working directory; `home` resets |
| `/connections` | Add, enable, disable, connect, remove, and inspect MCP servers |
| `/agents`, `/agent NAME` | Switch agent homes without restarting |
| `/new` | Create and switch to another agent |
| `/skills`, `/skill NAME` | List skills or read their instructions |
| `/use NAME TASK` | Explicitly request an installed skill |
| `/actions` | Inspect recent tool outcomes, including uncertain interruptions |
| `/app` | Theme and startup banner |
| `/resume`, `/clear`, `/exit` | Recovery, clear screen, exit |

Agent homes are discovered beside the current home, under `~/.donjon/agents`, and from previously opened paths. Duplicate agent names require a number or full path. Switching does not merge memory or conversations.

### Permissions and runtime

New homes start with shell, file modification, and MCP disabled. Existing homes without settings inherit `allowShell` from agent.json. Once settings.json exists, its permission switches take precedence; explicit worker `allowShell` overrides shell and file permissions for that run. Memory read/write and ordinary file reading remain available. Shell access can modify files even when the dedicated file tools are disabled. MCP servers execute with their own access. These are trusted tool-access controls, **not a filesystem sandbox** or per-command approval system. Code mode is available only when shell and file modification are both enabled.

Settings changes acquire the same ownership lock as runs. They apply to the next run; another active owner blocks changes. Runtime timeout 0 means unlimited. Changing the working directory selects a separate conversation within the same agent memory. Pending work must first be recovered with its original model and external workspace; restore those settings if a recovery check rejects a change.

### Connections

`/connections` supports local **stdio** servers and remote **Streamable HTTP** servers. Add a server, enable it, turn MCP on in `/permissions`, then connect (or start a run). Active means a live connection in this chat session; enabled is the saved preference. Headless workers connect only for the run and close afterward. Errors are shown separately. Settings changes or switching agents close current connections.

Stdio takes an executable and a JSON argument array, without a shell. Environment mappings reference names, e.g. `{"API_KEY":"MY_SERVICE_KEY"}`; HTTP bearer authentication likewise references a local environment variable. Do not put secrets in URLs or command arguments. OAuth login flows, legacy SSE transport, MCP resource browsing, and prompt catalogs are not implemented. Tools are discovered, namespaced, passed to the model with their input schemas, and recorded in action history. MCP tools are deliberately unsafe to replay after a crash: server annotations cannot guarantee an external effect was not already applied. Cancellation sends a request to the server; remote work may still finish.

### Skills and action evidence

Install `memory/skills/<name>/SKILL.md` in the agent memory repository and commit it; legacy `skills/<name>/SKILL.md` remains supported. Committed memory skills take precedence over legacy names. A bounded legacy catalog (up to 100 skills, four directory levels, files up to 64 KB) and the validated memory skill catalog is refreshed in the system context before each model request. Symlinks and hidden directories are ignored. YAML-style `description:` metadata supplies the catalog summary. The `skill_read` tool loads instructions on demand and records usage. This proves which instructions were loaded, not perfect model compliance. Skills never grant tool permissions.

Action intent is flushed to `state/actions.jsonl` before a tool starts. A completion receipt means the tool returned; it does not independently prove every external effect. Errors may leave partial effects. Missing receipts and interrupted calls are **unknown**. Inspect files or the external service before retrying uncertain work. Journals may include command arguments and should be treated as private agent state. The UI strips terminal control sequences from tool output.

## Agent homes

```text
agent.json             identity, model, instructions, allowShell
memory/                authoritative Markdown memory, with its own Git history
settings.json          per-agent runtime, working directory, permissions, connections
memory/.memfs.config.json  memory structure, size and read-only constraints
memory/skills/         agent skills stored with memory
skills/                legacy skills; memory skills take precedence
state/actions.jsonl    local action receipts and interruption evidence
state/runtime.sqlite   transcripts, submissions, tool results, recovery state
state/owner.sqlite     exclusive process-ownership lock
```

Core memory is compiled from one validated Git revision per turn, including after compaction. Existing homes migrate automatically on their next run; originals remain in Git. Deeper references stay out of context until read. Memory limits and read-only paths are configurable; defaults are 24,000 core characters and 20,000 characters per file, with a model-dependent context allowance. Memory changes use checked multi-file Git transactions; interrupted updates recover on restart. `/memory` provides inspection, search, history, synchronization and bundles. `/reflect` creates an evidence-backed proposal; apply it explicitly or use the headless `reflect HOME --apply` command from a Doer routine. See [Memory architecture and operations](MEMORY.md) for budgets, migration, recovery and limits.

Application appearance and known agent paths live in `~/.donjon/settings.json` (override the directory with `DONJON_CONFIG_DIR`).

The application Git repository tracks software. Agent memory has separate history. Runtime databases and credentials do not belong in this repository. Updating or cloning the software does not copy or replace agent homes.

A crash leaves work recoverable; an explicit stop or timeout cancels the submission. Under Doer, work that belonged to a run Doer cancelled is not resumed (see [Doer integration](DOER.md)). A second owner receives a busy error. Request IDs deduplicate the same logical input. Arbitrary shell/API effects require their own duplicate prevention. This is trusted local execution, not a filesystem sandbox.

Copy exports create a new agent identity and fresh execution state. Continuations also preserve newly recorded conversation recall. Continuation exports preserve identity and create a consistent SQLite snapshot. Both preserve current memory, skills, and settings; use `--history` to preserve memory Git history. exported MCP connections are disabled and require reactivation. Copy exports reset the working directory; continuation exports keep it and include the action journal. Without `--history`, exported memory starts fresh Git history. Use Git clone/bundle separately for full memory history. Relocated pending work requires compatible tools; external workspace paths and absolute paths embedded in prior tool arguments are not rewritten. Review memory/transcripts before sharing.

## Running under Doer

Optional. When `DOER_API_URL`, `DOER_API_KEY`, `DOER_COMPANY_ID` and `DOER_AGENT_ID` are all set in the environment, `donjon-agent run HOME PROMPT` works as a Doer agent through Doer's built-in `process` adapter, with no changes to Doer: it takes its request ID from the Doer run, reads its wake context, uses Doer's approvals and issues through `doer_*` tools, and reports its own cost. Without those variables nothing changes. Setup, the standing heartbeat prompt and safety notes are in [DOER.md](DOER.md). Not yet run against a real Doer instance or on Windows.

## Development and releases

```sh
npm run check                     # typecheck, tests, package install/API smoke test
python3 scripts/terminal-smoke.py  # optional real PTY Escape test (macOS/Linux)
npm run release:prepare -- 0.1.1   # prepare a new version and release notes
```

[Release process](RELEASING.md) · [Changelog](CHANGELOG.md) · [Doer integration](DOER.md)

The package installs as `donjon-agent`. GitHub releases contain an installable `.tgz` and SHA256SUMS. Public npm publishing is disabled.

[Memory guide](MEMORY.md) covers `/memory`, `/reflect`, history bundles, remote synchronization, and scheduling reflection through Doer.

## Source history

Extracted from Doer commit `039226f5` on 2026-11-11. Relevant file history was retained; extraction rewrote commit IDs. Doer's own adapters remain in Doer. This repository is the source of truth for future runtime changes.

Memory map: `/memory graph` shows core and deferred files. `/memory graph PATH` shows outgoing Markdown/wiki links and backlinks; `/memory read PATH` opens a file. The map uses committed memory and does not infer relationships.
