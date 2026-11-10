# Donjon durable agents

A local agent home with Markdown memory, Git history, and Pi Durable execution recovery. Use the same agent from a terminal or Doer. Requires Node **22.19+** and Git.

## Start

From the Doer checkout:

```sh
pnpm --filter @doerai/adapter-pi-durable build
node packages/adapters/pi-durable/dist/cli.js init "$HOME/.donjon/agents/dondog" DonDog ollama/qwen3:8b
node packages/adapters/pi-durable/dist/cli.js chat "$HOME/.donjon/agents/dondog"
```

Use an installed Ollama model, or choose a built-in `provider/model-id` and set its provider API key in your environment. Ollama defaults to `http://localhost:11434/v1` (override `OLLAMA_BASE_URL`). Provider credentials stay outside the agent manifest. The standalone archive installs the same CLI as `donjon-agent`. Install it with `npm install -g /absolute/path/to/donjon-agent-0.1.0.tgz`. Build an archive with `pnpm --filter @doerai/adapter-pi-durable package:standalone`.

```text
agent.json              version, identity, model, instructions, allowShell
memory/                 authoritative Markdown memory; its own local Git repository
  MEMORY.md             navigation and reference index
  persona.md            identity
  human.md              durable knowledge about the person
skills/                 SKILL.md procedures, read on demand
state/runtime.sqlite    conversations, submissions, tool results, recovery state
state/owner.sqlite      OS-backed exclusive ownership lock
```

Root Markdown files are injected before every model request, including after compaction. Deeper files stay out of context until read. Core memory is limited to 24,000 characters; individual files to 128 KB. A memory tool reads a file and returns its SHA-256; writes require that hash (or `missing` for a new file). Stale writes fail instead of overwriting newer edits. The agent is instructed to record important learning during work; automatic background dreaming/consolidation is not implemented.

New agents can read local files and update their own memory. Set `allowShell: true` in agent.json to enable Pi's local shell, general write/edit tools, and Codemode. This is trusted local execution, not a filesystem security sandbox. Shell commands can access the worker environment; only enable them for agents you trust.

## Commands

```sh
donjon-agent init HOME NAME PROVIDER/MODEL
donjon-agent chat HOME                    # /exit, /resume
donjon-agent run HOME 'Your task' REQUEST_ID
donjon-agent resume HOME
donjon-agent inspect HOME
donjon-agent export HOME NEW_DIRECTORY
donjon-agent export HOME NEW_DIRECTORY --continuation
```

The terminal interface is a simple line-oriented chat, not the stock Pi fullscreen TUI. All commands use the same durable runtime. A new session shares memory but has its own transcript; the runtime API and Doer task keys select sessions. Reuse a request ID only to retry the same logical input. Do not assign the same home to two different agents.

## Doer configuration

Choose `pi_durable` and configure:

```json
{
  "agentHome": "/absolute/path/to/.donjon/agents/dondog",
  "model": "ollama/qwen3:8b",
  "allowShell": true,
  "timeoutSec": 300
}
```

Optional: `cwd`, `instructionsFilePath`, `promptTemplate`, `env`, `apiBaseUrl` (Ollama), `apiKey` (prefer Doer secret-backed environment variables). The model comes from agent.json when omitted for an existing home. No home? The adapter creates one under `~/.doer/durable-agents/<company-hash>/<agent-hash>`.

Bind Doer's MemFS to **this home's memory directory** to inspect it in Doer. `memoryDir`, if explicitly configured, must resolve to that same directory. An unrelated automatically provisioned Doer memory binding is not imported or used by this runtime. This prevents interactive mode and exports from silently using a different memory store. Import existing memory by copying reviewed Markdown files into memory/ while the agent is stopped; keep core identity/preferences at its root.

A Doer worker receives that run's prompt, credentials, identity, task attribution, and logs. It reports its child PID for process management, structured result, token usage, and Pi catalog-based estimated cost. It never modifies the server's environment. Doer owns schedules and governance; this package does not run another scheduler.

## Recovery and portability

An explicit Doer stop or timeout sends SIGTERM and cancels the current submission. An unexpected process crash (including SIGKILL) leaves the submission pending. The next wake (or `resume`) recovers it before submitting new work. Completed request IDs return their stored answer without another model request. A second process gets an explicit busy error while the home is owned.

Memory writes are replay-safe. Arbitrary shell/API effects are **not exactly-once**: interrupted non-replay-safe tools return an interruption to the model. External integrations must use their own operation IDs/reconciliation. Process-crash recovery does not promise protection against loss of the host's newest writes during power failure.

Copy export creates a new identity with the current memory/skills and fresh execution state. Continuation export preserves identity and uses SQLite `VACUUM INTO` under the ownership lock for a consistent database snapshot. Both require a new destination directory. Model selection must remain unchanged until unfinished work settles. Exports start fresh Git history for the memory snapshot; use Git clone/bundle separately when the full memory history is needed. Hidden files and symlinks are excluded/refused, and machine credentials are not copied from the runtime environment. Memory and transcripts can contain personal data or tool output: review the material you choose to share.

Homes using their own workspace can be relocated. Pending work using an external workspace must resume in that same workspace. Absolute paths embedded in old tool arguments or transcript text are not rewritten; full continuation on another machine requires compatible tools and workspace paths. Provider access must be configured again on the receiving machine.

## Verification

```sh
pnpm --filter @doerai/adapter-pi-durable test
```

Tests cover fresh-session recall, request deduplication, stale-write rejection, traversal/symlink rejection, exclusive ownership, a real SIGKILL between a memory write and its tool-result commit, copy/continuation export, and the actual Doer subprocess against a local OpenAI-compatible test server. The integration test requires permission to listen on localhost; no paid model service is used.
