<p align="center"><img src="assets/banner.jpg" width="900" alt="Betta Agents: Small fish. Long memory."></p>

<p align="center">
  <b>A terminal agent harness with long-term memory you can read, search and roll back.</b><br>
  Built by <a href="https://donjon.agency">Donjon Intelligence Systems</a> · Works with <a href="https://doer.company">Doer</a> · MIT licensed
</p>

---

Betta Agents is a local agent harness: you give an agent a home folder, pick a model, and talk to it in your terminal. It runs commands, edits files and uses tools — and it keeps what it learns.

- **Memory that lasts.** Each agent's memory is plain Markdown in its own Git repository. Close the laptop, come back next week, and it still knows the project. You can read it, edit it, diff it and revert it.
- **Work that survives crashes.** Runs are checkpointed. If the process dies mid-task, the next start picks up where it left off instead of starting over or repeating the same request.
- **Any model.** Anthropic, OpenAI, OpenRouter, Google, Groq, NVIDIA, OpenCode, Z.ai, local Ollama and more, chosen from a live list.
- **You hold the switches.** Shell access, file writes and outside tools are off until you turn them on.

## Contents

[Install](#install) · [Your first agent](#your-first-agent) · [Models and logins](#models-and-logins) · [Using it](#using-it) · [Goal mode](#goal-mode) · [Memory](#memory) · [Skills](#skills) · [Tools and MCP](#tools-and-mcp-servers) · [Safety model](#safety-model) · [Reference](#reference) · [Development](#development) · [Status](#status)

## Install

Requires **Node.js 22.19 or newer** and **Git**. Tested on macOS and Linux. Windows is not supported yet.

**From a release** (recommended). Download `donjon-agent-<version>.tgz` and `SHA256SUMS` from [Releases](https://github.com/claybowl/betta-agent/releases), then:

```sh
shasum -a 256 -c SHA256SUMS
npm install -g ./donjon-agent-<version>.tgz
```

This installs two identical commands, `betta-agents` and `donjon-agent`.

**From source:**

```sh
git clone https://github.com/claybowl/betta-agent.git
cd betta-agent
npm ci --ignore-scripts
npm run build
./donjon-agent --help
```

## Your first agent

An agent is a folder (its *home*). Create one with a name and a model, then open a chat:

```sh
betta-agents init ~/.donjon/agents/scout "Scout" ollama/qwen3.5:9b
betta-agents chat ~/.donjon/agents/scout
```

No local model? Use any provider instead, for example `openrouter/anthropic/claude-sonnet-4.5`, and sign in with `/login` once the chat opens. You can change the model at any time with `/model`.

Type a message to give the agent work. Type `/` to open the command palette.

## Models and logins

**`/model`** opens a searchable list of every model the runtime knows. Type to filter (`nvidia`, `free`, `glm`…), arrow keys to move, Enter to pick.

| Mark | Meaning |
| --- | --- |
| `● live` | The provider's own API lists this model right now |
| `○ catalog` | Known to the runtime, not confirmed live |
| `◌ new` | Offered by the provider, but this version can't run it yet |
| `needs NVIDIA_API_KEY` | No credentials for that provider yet |
| `free` | Costs nothing to use |

Model names are `provider/model-id`. Some providers namespace their own IDs, so the provider can appear twice — for example `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b`. If you type a name that doesn't exist, Betta refuses it and suggests the closest matches.

**`/login`** saves a provider API key once, so you don't have to export it in every shell. Keys are typed hidden and stored in `~/.donjon/credentials.json`, readable only by you. Environment variables such as `OPENAI_API_KEY` or `NVIDIA_API_KEY` keep working and need no login. `/logout` removes a saved login.

**Subscriptions.** `/login openai` offers *Sign in with ChatGPT*, which uses your ChatGPT plan's allowance instead of API billing. Claude Pro/Max sign-in is not offered: Anthropic's terms reserve it for Claude Code and claude.ai. Use an Anthropic API key instead.

**Local models.** Ollama is used at `http://localhost:11434/v1` by default; set `OLLAMA_BASE_URL` to point elsewhere.

## Using it

Type `/` and the palette appears under the prompt. Keep typing to filter, Tab to complete, Enter to run, Esc to close. **Esc during a turn stops it**, including any command it is running. Ctrl-C on an empty line exits.

| Command | What it does |
| --- | --- |
| `/model [PROVIDER/ID]` | Pick a model, or set one directly |
| `/login [PROVIDER]` · `/logout` | Save or remove a provider login |
| `/goal OBJECTIVE` | Keep working until done — see [Goal mode](#goal-mode) |
| `/agents` · `/agent NAME` · `/new` | Switch agents or create one |
| `/skills` · `/skill NAME` · `/use NAME TASK` | Browse skills, read one, or ask the agent to use one |
| `/sessions` · `/session ID` | List and continue conversations with completed turns in this working directory |
| `/fork N` | Start and select a new conversation through completed turn N |
| `/memory` | Inspect, search and sync memory |
| `/reflect` | Have the agent propose what it should remember |
| `/permissions` | Shell, file writes, MCP tools |
| `/tools` | Show live permissions, server status, and discovered MCP tools |
| `/connections` | Add and manage MCP servers |
| `/cwd [PATH]` | Set the folder the agent works in |
| `/compact` | Summarize older context in the selected conversation |
| `/runtime` | Turn limit, compaction, timeout |
| `/actions` | Recent tool calls and their outcomes |
| `/resume` | Continue work interrupted by a crash |
| `/settings` · `/theme` · `/app` | Settings, colors (`magic`, `purple`, `plain`), startup banner |
| `/clear` · `/exit` | Clear the screen, leave |

Use `/session default` to return to the default conversation. To continue from a script, list IDs with `betta-agents sessions HOME` and pass one to `betta-agents run HOME PROMPT --session ID`. The `/resume` command still recovers interrupted work.

`/fork N` counts completed user turns from one in the selected conversation, including inherited turns. The fork includes the selected turn's assistant answer. Both conversations are available in `/sessions` immediately, and each continues independently.

`/compact` runs on demand even when automatic compaction is off. It keeps the conversation selected and leaves original messages available to recall.

Set `NO_COLOR=1` for no colors, or `DONJON_NO_MOTION=1` to skip the startup animation.

Older saved 50-turn limits migrate to 150 on first read. To use 50, set `maxTurns 50` in the Runtime section of `/settings`. The saved choice persists across restarts.

## Goal mode

Give the agent an objective and let it run:

```text
/goal --rounds 6 --budget 1.50 get the test suite passing and summarize what changed
```

The agent takes turn after turn without asking you questions, and ends each turn with a status line: done, continue, or blocked (with what it needs). The loop stops when it reports done or blocked, after the turn limit, or once the spend limit is reached. Defaults are 8 turns and $2. Esc stops it at any point.

## Memory

Each agent's memory lives in `HOME/memory/` as Markdown files under their own Git history:

- **Core memory** (identity, preferences, a routing index) is loaded into every turn.
- **Deeper files** stay out of context until the agent reads them, so memory can grow without crowding the prompt.
- Every change is a checked Git commit. Interrupted updates are recovered on restart.

`/memory` shows status, searches, opens files, shows history and diffs, reverts, and syncs to a Git remote. `/memory graph` maps links between files.

`/reflect` asks the agent to review the newest conversation messages that haven’t already been used in an applied proposal. It can reach older messages when newer ones have already been used. Each proposed memory change cites its source messages. Nothing changes until you apply the proposal.

`/reflect status` shows how many messages in the next window of up to 200 unconsumed messages fit the configured character budget. It distinguishes an empty window from a first message that exceeds the budget. It leaves proposals and consumed evidence unchanged and makes no model call.

Full details — budgets, migration, recovery and sync — are in the [memory guide](MEMORY.md).

## Skills

A skill is a folder with a `SKILL.md` describing how to do something. Put skills in `HOME/memory/skills/<name>/SKILL.md` and commit them with the agent's memory (the older `HOME/skills/` location still works).

The agent sees each skill's name and `description` and loads the full instructions only when it needs them. `/skills` lists what's installed, and also lists any folder it skipped with the reason. Skills never grant extra permissions.

## Tools and MCP servers

With permissions on, the agent can run shell commands and edit files. It can also use tools from [MCP](https://modelcontextprotocol.io) servers:

1. `/connections` → add a local (stdio) or remote (Streamable HTTP) server.
2. Enable it, then turn MCP on in `/permissions`.

Secrets are referenced by environment-variable name, never stored in settings. Not yet supported: MCP OAuth, the legacy SSE transport, and resource and prompt browsing.

## Safety model

Read this before turning on the shell.

- **Off by default.** New agents start with shell, file writes and MCP disabled. Memory and reading files always work.
- **Not a sandbox.** The switches control which tools the agent gets. With the shell on, the agent can do anything your user account can, including changing files when file tools are off.
- **Evidence, not guarantees.** Every tool call is written to `state/actions.jsonl` before it starts and confirmed when it returns. If a run is interrupted mid-call, that call is marked *unknown*: check the outside effect before retrying. Shell commands and API calls are not exactly-once.
- **One owner at a time.** Two processes can't drive the same agent at once; the second gets a busy error.
- **Your data stays yours.** Agent homes, memory and credentials are never part of the software, a release or this repository.

## Reference

### Command line

```text
betta-agents init HOME NAME PROVIDER/MODEL     create an agent
betta-agents chat HOME                         interactive terminal
betta-agents run HOME PROMPT [REQUEST_ID]      one headless turn
betta-agents resume HOME                       finish interrupted work
betta-agents inspect HOME                      show identity and state
betta-agents export HOME NEW_DIR [--continuation] [--history]
betta-agents memory HOME COMMAND [ARGS]
betta-agents reflect HOME [--apply [ID] | --status | --list | --preview ID | --discard ID | --retry ID]
```

`reflect HOME --status` prints the eligible evidence counts as JSON. `reflect HOME --list` prints the same JSON array of saved proposals as chat's `/reflect list`. Use a proposal ID from that list with `reflect HOME --preview ID` to see the saved proposal and its diff as JSON. Status, listing, and preview are read-only and make no provider calls. Use `reflect HOME --apply ID` to apply a saved proposal and print the result as JSON without a provider call. Bare `--apply` runs reflection and applies the resulting proposal if it is ready. Use `reflect HOME --discard ID` to decline a saved proposal and print the result as JSON. Discard leaves committed memory and evidence consumption unchanged and makes no provider call. Use `reflect HOME --retry ID` to retry a failed or interrupted proposal and print the result as JSON. A ready proposal still requires explicit application. Choose at most one reflection flag. The standalone command rejects unknown arguments before starting reflection.

`run` with the same `REQUEST_ID` executes once, however many times it is started.

When `resume` or standalone `run` recovers interrupted work, it prints the request ID to stderr and the final summary to stdout.

### Agent home layout

```text
agent.json              name, model, instructions
settings.json           permissions, working directory, connections, limits
memory/                 Markdown memory with its own Git history
memory/skills/          skills, stored with memory
state/actions.jsonl     tool-call receipts
state/runtime.sqlite    transcripts and recovery state
state/owner.sqlite      single-owner lock
```

App-wide settings live in `~/.donjon/` (`settings.json`, `credentials.json`). Set `DONJON_CONFIG_DIR` to move it.

### Exporting an agent

`export` copies an agent to a new folder. A plain export creates a **new agent** with the same memory, skills and settings. `--continuation` keeps the **same identity** and its conversation state. `--history` also keeps memory's Git history. Exported MCP connections are switched off. Review memory and transcripts before sharing an export.

### Running under Doer

Betta agents can run as workers in [Doer](https://doer.company), an agent orchestration platform. Set `DOER_API_URL`, `DOER_API_KEY`, `DOER_COMPANY_ID` and `DOER_AGENT_ID`, and `run` picks up Doer's tasks, approvals and issues, and reports its own cost. Without those variables nothing changes. See [DOER.md](DOER.md).

### HTTP and Chrome connectivity

Enable `network` in `/permissions` to expose `http_request` independently of shell access. Requests support HTTP(S), methods, headers, optional body, credential environment references, bounded response text, cancellation and timeouts. Redirects are returned without following. This permission allows local network services too; it is not a network sandbox. Request bodies, headers and query strings are omitted from the action-history argument summary; responses still enter the conversation.

`/connections` now offers an arrow-key menu, a remote URL shortcut and a browse Chrome preset. Install browse from its official installer and pair the extension in your chosen Chrome profile, then select **Connect my Chrome with browse**. The preset enables MCP and saves the stdio connection. Other services still require their own server and authentication; OAuth login is not implemented. `/tools` shows live connection status, and every model turn receives a host capability report. The agent can refresh it using `capabilities`.

### System instructions and built-in skills

`/prompt` (also Settings → System prompt) displays or replaces this agent’s base system instructions in `agent.json`. Use `edit` to paste multiple lines, ending with `.save` or `.cancel`, or `file` to import a UTF-8 file. Memory, the bundled operating brief, live capabilities and run instructions supplement that base. Changes apply next turn.

The bundled `betta-agent` brief loads on every run, including Doer worker runs. It routes substantive tasks to relevant skills without requiring skill loads for trivial conversation. The Vercel browser and desktop discovery skills are bundled; guides come from the installed CLI versions. Enable `browser` or `desktop` in `/permissions` to expose the dedicated `agent_browser` or `agent_desktop` argument-array tool without enabling a general shell. Install the CLIs on each worker; browser logins and macOS permission grants remain specific to that machine. User-local ~/.local/bin installations take priority over PATH.

Core memory budgeting uses an approximate UTF-8 byte-based token estimate. The preferred allocation is 15% of the selected model context; larger memory continues with a warning up to 40%. Above that, Betta explains the sizes and recovery options before starting inference. This allocation is a heuristic, not a guarantee that the entire prompt fits. Personal memory files are never automatically truncated.

## Development

```sh
npm ci --ignore-scripts
npm run check                       # typecheck, tests, package install check
python3 scripts/terminal-smoke.py   # real-terminal keyboard test (macOS/Linux)
```

TypeScript, Node 22.19+. Dependencies are pinned in `npm-shrinkwrap.json`. Releases are cut from tags by GitHub Actions; see [RELEASING.md](RELEASING.md). Changes are listed in the [changelog](CHANGELOG.md).

Contributions are welcome. Open an issue first for anything large. Run `npm run check` before sending a pull request.

## Status

Pre-1.0: state formats and commands may still change between minor versions, and every change is noted in the changelog with migration steps.

Known limits:

- Windows is not supported yet.
- *Sign in with ChatGPT* has been verified only up to the browser step.
- Saved logins are stored in an owner-only file, not the system keychain.
- The Doer integration is tested against a simulated Doer API only.

## Credits and license

Betta Agents is built by [Donjon Intelligence Systems](https://donjon.agency) on the [Pi](https://github.com/earendil-works/pi) agent runtime (`pi-ai`, `pi-durable`). The memory layout follows the core/deferred design of Letta's MemFS; the implementation is original. Originally extracted from Doer.

[MIT License](LICENSE).
