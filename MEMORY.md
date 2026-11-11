# Memory architecture and operations

Donjon memory follows Letta's MemFS v2 core/deferred layout. Markdown and Git are authoritative. SQLite recall is a separate evidence store. The implementation is original; the source comparison is recorded in the local Letta research report.

## Storage

```
agent-home/
  agent.json
  memory/                    independent Git repository
    .memfs.config.json
    MEMORY.md                core routing index
    persona.md               core identity
    human.md                 core human preferences
    projects/
      MEMORY.md              deferred index
      example.md             deferred knowledge
    skills/example/SKILL.md  agent memory skill
  skills/                    legacy skills, lower precedence
  state/
    runtime.sqlite           Pi execution and transcript state
    recall.sqlite            searchable user/assistant message receipts
    memory-active.json       most recently activated core revision
    memory-transaction.json  present only during a recoverable update
    reflection-proposals.json
    reflection-consumed.json
    reflection-settings.json
    reflection-worktrees/    isolated proposals retained for inspection
```

On first use the harness migrates legacy root Markdown and `system/**/*.md` (nested names become stable underscore-separated root block names), adds frontmatter and missing indexes, and commits the migration. The old committed files remain in Git. A root/system filename collision stops migration for repair. Existing large files are preserved within supported limits, not truncated. Invalid or credential-bearing input is rejected. A valid existing configuration bypasses migration.

Root blocks render in alphabetical order, with root MEMORY.md last. Name/description frontmatter is removed from their bodies; descriptions render separately. Legacy blocks without frontmatter remain readable for old tool-call compatibility. Generated deferred routes list top-level directories with indexes; reference contents are loaded only when requested. Every deferred directory requires an index. Skills are excluded from deferred projection.

## Activation and writes

The compiler resolves a single commit SHA and reads every blob at that revision. It caches bounded snapshots by repository, revision and budget. A turn receives an immutable core snapshot, which Pi restores when preparing model context, including after compaction. New commits enter core context on the next turn. `/memory refresh` validates and records a newly active revision between turns. Status shows HEAD and the last activated revision separately.

Core has a configured character ceiling (default 24,000), and the runtime applies a smaller model-context allowance when needed. The displayed token count is an estimate based on UTF-8 bytes, not a provider tokenizer measurement. A too-small model budget rejects generation rather than silently dropping core memory. Default per-file limit is 20,000 characters; migration can raise it to preserve existing files. Absolute file and tree admission limits are 128 KB/file, 1,000 files and 4 MB total. Default deferred depth is four directories. Config permits read-only globs and per-file limit overrides.

Memory tools use committed hashes for compare-and-swap updates. `memory_update` makes one learning across up to 50 files, including deletions, with a reason and source IDs. `memory_write` preserves the older single-file interface. Missing reference indexes are created in the same transaction. Direct shell edits remain drafts until `/memory commit REASON` validates them. Dedicated tools refuse to overwrite conflicting working drafts. Unrelated drafts remain on disk and are not silently included in a model learning commit.

A temporary Git index constructs a validated tree. The harness persists a recovery journal, updates HEAD with compare-and-swap, materializes the changed working files and clears the journal. A restart resumes an interrupted transaction. Durable Pi task IDs deduplicate tool replays. The home SQLite ownership lock serializes harness writers, reflection and management commands. Shell access remains trusted local execution; arbitrary out-of-band writers are not an OS-enforced sandbox. Unexpected working-tree changes retain the journal for repair rather than overwrite them.

An invalid externally committed HEAD falls back to the last valid active revision when available. Inspect `/memory status` for the warning and repair or revert the bad commit. Normal tool transactions validate before they can activate.

## Recall and evidence

The harness records user input and assistant answers from upgrade onward. IDs use the stable request ID plus role; replayed requests do not append duplicate receipts. Search is scoped to one agent home. Existing Pi databases retain their old transcripts; this release does not backfill historical tool, reasoning or conversation events into recall. Recall stores neither reasoning nor raw tool transcripts. This keeps reflection inputs bounded and easy to inspect.

`memory_search` performs lexical search across committed Markdown and returns path, line and revision. `recall_search` returns recorded messages and source IDs. These tools are available with shell disabled. Retrieval is lexical, not an embeddings service; it does not guarantee arbitrary paraphrase matching. Index descriptions should use the words future requests are likely to use.

Known credential patterns and values from secret-named environment variables are rejected in new memory content and commit messages, and redacted in recall. This is a best-effort guard, not a general detector of every secret. Existing Git history and external files can still contain private information. Review history before sharing a bundle.

## Commands

Inside chat:

```
/memory status
/memory browse
/memory read projects/example.md
/memory search deployment rollback
/memory recall boat
/memory core
/memory diff
/memory diff FULL_OR_SHORT_COMMIT
/memory history
/memory refresh
/memory commit Explain the durable learning
/memory revert FULL_OR_SHORT_COMMIT
/memory config
/memory config {"version":1,"maxCoreMemoryCharacters":18000}
/memory bundle /absolute/path/new-memory.bundle
/memory remote git@github.com:you/private-agent-memory.git
/memory push
/memory pull
/reflect
/reflect list
/reflect apply PROPOSAL_ID
/reflect discard PROPOSAL_ID
/reflect retry PROPOSAL_ID
/reflect settings
```

A revert creates a new commit with the selected memory content. It does not rewind execution state or rewrite history. Configuration JSON merges with defaults; when changing settings, include every non-default value you want to preserve.

Headless equivalents:

```sh
./donjon-agent memory HOME status
./donjon-agent memory HOME search 'deployment rollback'
./donjon-agent memory HOME transcript-export /absolute/path/new-recall.json
./donjon-agent reflect HOME
./donjon-agent reflect HOME --apply
./donjon-agent export HOME NEW_HOME --continuation --history
./donjon-agent memory-import MEMORY_BUNDLE NEW_HOME NAME PROVIDER/MODEL
```

Transcript export currently includes the latest 200 recorded messages. Files require a new destination. Import requires a new home and a new identity. A plain snapshot export starts fresh memory history. `--history` uses a Git bundle to preserve commits and proposal branches, without copying local Git credentials or remotes. Continuation exports retain runtime identity and SQLite state, and copy recall; with history they also preserve proposal/consumption metadata. Failed import directories are retained and marked for inspection. Bundles retain all memory/proposal history, including historical private text; they do not sanitize history.

Remote setup is explicit; no background pushes occur. HTTPS credential helpers or SSH supply credentials. Push never force-pushes. Pull fetches, requires a compatible fast-forward ancestry, validates the candidate tree, imports it through the transaction journal and preserves upstream ancestry. Divergence stops for explicit resolution. Remote content is never executed as hooks; unvalidated remote memory is never automatically compiled.

## Reflection

Reflection makes one bounded model request to propose JSON changes using recent unconsumed recall and existing memory. It has no shell, MCP or tool execution. The result must cite supplied source IDs. Changes are validated in an isolated Git worktree and committed to a proposal branch. Preview does not activate the proposal. No-op results create no memory commit. The same source window/base revision is deduplicated. Failed or interrupted requests require an explicit retry; committed work can be recovered without repeating generation.

Apply computes a three-way merge without modifying the parent checkout, validates its resulting tree, then integrates under ownership. Conflicts retain the proposal branch/worktree and leave evidence unconsumed. Source IDs are consumed only after successful integration. If a crash follows the merge, ancestry/transaction receipts let apply finish bookkeeping idempotently. Discard retains evidence for a future proposal and preserves the branch for inspection; it does not delete history.

Default reflection budget: 16,000 evidence characters, up to 32,000 additional memory characters, 2,048 output tokens, 60 seconds, and a $0.25 estimated ceiling. A separate model can be selected in `/reflect settings`. Preflight checks catalog pricing; actual provider usage is recorded, and over-budget output is not activated. Provider pricing/usage may differ, so this is not a billing guarantee. Whole inputs that exceed the budget fail visibly instead of being silently truncated. Timeout/cancellation can still incur provider charges. Direct CLI reflection uses environment credentials and requires no new service.

A Doer routine can run `donjon-agent reflect HOME` for proposals or `--apply` when automatic application is desired. Existing ready proposals are reused. The ownership lock returns busy if the interactive agent is running; a routine should retry on its next scheduled wake. No OS cron jobs are installed automatically. This command is independent of Doer's embedded adapter runtime.

## Validation

Tests cover migration and original history, committed-only projection, stale writes, multi-file crash recovery, invalid-head fallback, protected files, credential fixtures, agent isolation, activation boundaries, proposal provenance, no-op reflection, conflict retention, local Git synchronization, exports/imports, model budgets and Pi compaction. Model responses in automated tests are deterministic local fixtures; these checks prove harness behavior, not the factual quality of every model-generated memory. Evaluate memory quality on your own correction/recall tasks before enabling automatic reflection broadly.
