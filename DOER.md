# Running under Doer

From 0.4.0 this runtime can run as a Doer agent with **no changes to Doer**, through Doer's built-in `process` adapter. Doer starts `donjon-agent run HOME PROMPT` on each heartbeat; the runtime talks to Doer's HTTP API for everything else.

The integration is optional. It is active only when all four of `DOER_API_URL`, `DOER_API_KEY`, `DOER_COMPANY_ID` and `DOER_AGENT_ID` are present in the process environment. Without them nothing Doer-related is installed, no network call is made, and the runtime behaves as it did in 0.3.0. These values are read from the environment only; they are never written to `agent.json`, `settings.json`, memory, exports or the action journal.

Status: built and tested against a fake Doer API in this repository's test suite. It has **not** been run against a real Doer instance or on Windows. Treat the setup below as the intended procedure, to be confirmed on a development instance first.

## What the runtime does under Doer

- **Finds its run.** At start it asks Doer for this agent's recent heartbeat runs and takes the newest `running` one. That run id becomes the request id, so starting the same run twice executes once. If Doer cannot be reached, or no running run is found, the run proceeds with a random id and logs that deduplication is off for that start.
- **Reads why it was woken.** It reads the run's context (wake reason, task, comment, approval and linked issue ids) and exposes them as the same `DOER_*` wake variables Doer's other adapters pass.
- **Does not resume cancelled work.** If unfinished work belongs to a run Doer marked `cancelled`, it is dropped instead of resumed. `failed` and `timed_out` runs recover normally. This is what makes Doer's stop stick on Windows, where the stop is a hard kill that looks like a crash locally. On macOS and Linux the `run` command also honors Doer's stop signal directly.
- **Uses Doer's approvals.** Doer's approvals are the only record; the runtime keeps no approval list. Tools: `doer_approval_request` (types `hire_agent` and `approve_ceo_strategy`, with linked issue ids), `doer_approval_read`, `doer_approval_issues`, `doer_approval_comment`, `doer_approval_resubmit`, `doer_approvals_mine`. There is no tool to approve, reject or request a revision. Creating an approval is not repeated after a crash; reconcile with `doer_approvals_mine`.
- **Checks for decisions Doer does not announce.** Doer wakes the requester only when an approval is approved. Each run the runtime lists this agent's `revision_requested` approvals and its approvals rejected since its last completed run, and puts them in front of the model. When woken for an approved approval it reads that approval and its issues first.
- **Works its issues.** `doer_inbox`, `doer_issue_read`, `doer_issue_comments`, `doer_issue_checkout`, `doer_issue_update`, `doer_issue_comment`, following the procedure in Doer's `skills/doer/SKILL.md`. Changes carry the `X-Doer-Run-Id` header.
- **Reports its own cost.** The `process` adapter reports no usage, so Doer's budget limit would not see this agent's spend. After each run the runtime posts its real token usage and cost to Doer's cost-events endpoint for itself. This is best effort and never fails the run.
- **Logs to the run log.** Integration events are written to stderr as `[doer] {...}` lines; the answer goes to stdout. Doer keeps both.

Tool permission switches (`shell`, `files`, `mcp`) are a separate layer from Doer approvals and are unchanged.

## Setup (create the agent through Doer's API)

Doer hides `process` from its create-agent menu on purpose, so create the agent with the API. Run these against a **development** Doer first.

1. Create an agent home on the machine that runs Doer and note its absolute path:

   ```sh
   donjon-agent init /absolute/path/to/home "Agent name" provider/model
   ```

2. Create the agent: `POST /api/companies/{companyId}/agents`

   ```json
   {
     "name": "Agent name",
     "adapterType": "process",
     "adapterConfig": {
       "command": "donjon-agent",
       "args": ["run", "/absolute/path/to/home", "<standing heartbeat prompt, below>"],
       "cwd": "/absolute/path/to/home",
       "timeoutSec": 1800,
       "graceSec": 20,
       "env": {}
     }
   }
   ```

3. Create a key for that agent: `POST /api/agents/{agentId}/keys` with `{"name": "donjon-agent"}`. Doer shows the key once.

4. Put the key in the agent's `adapterConfig.env` as `DOER_API_KEY`, together with the model provider's API key variable. Doer supplies `DOER_AGENT_ID`, `DOER_COMPANY_ID` and `DOER_API_URL` itself. If your Doer does not listen on its default address, also set `DOER_API_URL` there (development instances commonly use port 3101).

Notes:

- On Windows, `command` must resolve to something Doer can start. If `donjon-agent` is not found, use `node` as the command and the full path to `dist/cli.js` as the first argument.
- Doer's `timeoutSec` and this runtime's own timeout setting are independent; the shorter one wins.
- The key lives in Doer's database and in this process's environment only. Rotate it in Doer if it is exposed.

### Standing heartbeat prompt

Use this as the third `args` entry. It is the same every heartbeat; the runtime adds the run-specific context.

```text
This is a Doer heartbeat. Follow the Doer briefing in your instructions. First handle any approval decision, rejected approval or approval returned for revision listed there. Then call doer_inbox. Work on in_progress issues first, then todo; skip blocked issues unless you can unblock them. Check out an issue with doer_issue_checkout before working on it, and stop if it belongs to another agent. Read context with doer_issue_read and doer_issue_comments. When you finish or get blocked, record it with doer_issue_update and a comment that says what was done or who must act. If an action needs board sign-off, ask with doer_approval_request and link the issue; never act as if it were approved. If nothing is assigned and nothing needs follow-up, say so in one line and stop.
```

## Safety

- **Approvals are a workflow record, not a security boundary, on a default Doer install.** In Doer's `local_trusted` mode a local request without a valid token is treated as the board. An agent with shell access could therefore approve its own request. Keep this runtime's shell switch **off** for any agent whose approvals are supposed to mean something, until Doer's own security review changes that.
- Do not put secret values in approval payloads, comments or issues. The Doer tools refuse content containing a known credential, and Doer redacts by field name only.
- Arbitrary shell and API effects are not exactly-once. A Doer mutation whose outcome is unknown after a crash is not retried automatically.

## Limits

- No per-run token: the `process` adapter passes a stored agent key.
- Doer's "nothing to do" backoff signal (`{"noop": true}` in the run result) cannot be sent through the `process` adapter.
- Rejections are noticed on the next heartbeat, not immediately.
- If Doer is unreachable at start, a cancelled run cannot be recognized and unfinished work resumes as it did before 0.4.0.
- Doer's `pi_durable` adapter does not use this runtime. Earlier versions of this document said it included a snapshot of it; on Doer's current default branch it does not.

## Library and other adapters

The public runtime entry point is `donjon-agent` (`runAgent`) and home utilities are `donjon-agent/home`. An adapter that starts `donjon-agent worker` and passes `DOER_RUN_ID` itself is honored: that id is used instead of the lookup. Keep the agent home stable across desktop, terminal and Doer entry points, and bind Doer MemFS to that home's `memory/` directory.
