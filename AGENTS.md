# Donjon Agent

Standalone TypeScript runtime for portable, stateful local agents. Keep Doer orchestration in Doer.

- Runtime: src/harness.ts; agent home/memory/export: src/home.ts; CLI: src/cli.ts.
- Use npm with npm-shrinkwrap.json. Node 22.19+ is required.
- Before handoff run npm run check and npm run release:check.
- Keep agent homes, credentials, databases, personal memories, and generated artifacts out of Git.
- Preserve recovery, request deduplication, exclusive ownership, cancellation, and export compatibility.
- Never describe arbitrary external effects as exactly-once.
- Release commands and version/state compatibility rules are in RELEASING.md.
