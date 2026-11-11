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
chat HOME                         /exit, /resume
run HOME PROMPT [REQUEST_ID]
resume HOME
inspect HOME
export HOME NEW_DIRECTORY
export HOME NEW_DIRECTORY --continuation
```

The terminal is line-oriented chat. Shell and general file modification tools are available when `allowShell` is true in agent.json. They are disabled for new homes. MCP, desktop UI, and in-app settings are future features.

## Agent homes

```text
agent.json             identity, model, instructions, allowShell
memory/                authoritative Markdown memory, with its own Git history
skills/                procedures read on demand
state/runtime.sqlite   transcripts, submissions, tool results, recovery state
state/owner.sqlite     exclusive process-ownership lock
```

Root Markdown is loaded before each model request, including after compaction. Deeper references stay out of context until read. Core memory is limited to 24,000 characters; individual memory files to 128 KB. Memory changes use atomic replacements and version checks; already-applied replacements are safe to replay. The agent is prompted to record important learning, but automatic background consolidation is not implemented.

The application Git repository tracks software. Agent memory has separate history. Runtime databases and credentials do not belong in this repository. Updating or cloning the software does not copy or replace agent homes.

A crash leaves work recoverable; an explicit Doer stop or timeout cancels the submission. A second owner receives a busy error. Request IDs deduplicate the same logical input. Arbitrary shell/API effects require their own duplicate prevention. This is trusted local execution, not a filesystem sandbox.

Copy exports create a new agent identity and fresh execution state. Continuation exports preserve identity and create a consistent SQLite snapshot. Both preserve current memory and skills; exported memory starts fresh Git history. Use Git clone/bundle separately for full memory history. Relocated pending work requires compatible tools; external workspace paths and absolute paths embedded in prior tool arguments are not rewritten. Review memory/transcripts before sharing.

## Development and releases

```sh
npm run check                     # typecheck, tests, package install/API smoke test
npm run release:prepare -- 0.1.1   # prepare a new version and release notes
```

[Release process](RELEASING.md) · [Changelog](CHANGELOG.md) · [Doer integration](DOER.md)

The package installs as `donjon-agent`. GitHub releases contain an installable `.tgz` and SHA256SUMS. Public npm publishing is disabled.

## Source history

Extracted from Doer commit `039226f5` on 2026-11-11. Relevant file history was retained; extraction rewrote commit IDs. The Doer adapter and its subprocess integration tests remain in Doer. This repository is the source of truth for future runtime changes.
