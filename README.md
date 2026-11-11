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

Install `skills/<name>/SKILL.md` in the agent home. A bounded catalog (up to 100 skills, four directory levels, files up to 64 KB) is refreshed in the system context before each model request. Symlinks and hidden directories are ignored. YAML-style `description:` metadata supplies the catalog summary. The `skill_read` tool loads instructions on demand and records usage. This proves which instructions were loaded, not perfect model compliance. Skills never grant tool permissions.

Action intent is flushed to `state/actions.jsonl` before a tool starts. A completion receipt means the tool returned; it does not independently prove every external effect. Errors may leave partial effects. Missing receipts and interrupted calls are **unknown**. Inspect files or the external service before retrying uncertain work. Journals may include command arguments and should be treated as private agent state. The UI strips terminal control sequences from tool output.

## Agent homes

```text
agent.json             identity, model, instructions, allowShell
memory/                authoritative Markdown memory, with its own Git history
settings.json          per-agent runtime, working directory, permissions, connections
skills/                procedures cataloged and loaded on demand
state/actions.jsonl    local action receipts and interruption evidence
state/runtime.sqlite   transcripts, submissions, tool results, recovery state
state/owner.sqlite     exclusive process-ownership lock
```

Root Markdown is loaded before each model request, including after compaction. Deeper references stay out of context until read. Core memory is limited to 24,000 characters; individual memory files to 128 KB. Memory changes use atomic replacements and version checks; already-applied replacements are safe to replay. The agent is prompted to record important learning, but automatic background consolidation is not implemented.

Application appearance and known agent paths live in `~/.donjon/settings.json` (override the directory with `DONJON_CONFIG_DIR`).

The application Git repository tracks software. Agent memory has separate history. Runtime databases and credentials do not belong in this repository. Updating or cloning the software does not copy or replace agent homes.

A crash leaves work recoverable; an explicit Doer stop or timeout cancels the submission. A second owner receives a busy error. Request IDs deduplicate the same logical input. Arbitrary shell/API effects require their own duplicate prevention. This is trusted local execution, not a filesystem sandbox.

Copy exports create a new agent identity and fresh execution state. Continuation exports preserve identity and create a consistent SQLite snapshot. Both preserve current memory, skills, and settings; exported MCP connections are disabled and require reactivation. Copy exports reset the working directory; continuation exports keep it and include the action journal. Exported memory starts fresh Git history. Use Git clone/bundle separately for full memory history. Relocated pending work requires compatible tools; external workspace paths and absolute paths embedded in prior tool arguments are not rewritten. Review memory/transcripts before sharing.

## Development and releases

```sh
npm run check                     # typecheck, tests, package install/API smoke test
python3 scripts/terminal-smoke.py  # optional real PTY Escape test (macOS/Linux)
npm run release:prepare -- 0.1.1   # prepare a new version and release notes
```

[Release process](RELEASING.md) · [Changelog](CHANGELOG.md) · [Doer integration](DOER.md)

The package installs as `donjon-agent`. GitHub releases contain an installable `.tgz` and SHA256SUMS. Public npm publishing is disabled.

## Source history

Extracted from Doer commit `039226f5` on 2026-11-11. Relevant file history was retained; extraction rewrote commit IDs. The Doer adapter and its subprocess integration tests remain in Doer. This repository is the source of truth for future runtime changes.
