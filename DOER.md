# Doer integration boundary

The standalone runtime is owned by this repository. The Doer adapter remains in Doer's packages/adapters/pi-durable package and owns wake prompts, task attribution, credentials, worker processes, cancellation, logs, usage reporting, and MemFS bindings.

The existing Doer adapter currently includes the original runtime snapshot from source commit 039226f5; extracting this repository does not silently change running agents or that dependency. A follow-up adapter update should replace its copied runtime with a pinned tested release archive from this repository. Do not assume Doer automatically consumes new harness releases.

The public runtime entry point is `donjon-agent` (runAgent) and home utilities are `donjon-agent/home`. The terminal entry point is the donjon-agent binary. Keep agentHome stable across desktop, terminal, and Doer entry points. Bind Doer MemFS to that home's memory/ directory. Doer's schedules and governance remain outside the runtime.

When updating the adapter dependency, run Doer's subprocess/localhost-provider integration test in addition to this repository's recovery suite. Keep shell/API side-effect handling explicit; a runtime upgrade does not make external operations exactly-once.
