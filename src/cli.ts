#!/usr/bin/env node
import { memoryCommand, importMemoryBundle } from "./memory-service.js";
import { reflect, applyReflection, discardReflection, previewReflection, proposals, reflectionStatus, retryReflection } from "./reflection.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chat } from "./chat.js";
import { providerProgressText } from "./tui.js";
import { initHome, readManifest, exportHome } from "./home.js";
import { listSessions, runAgent, type RunInput } from "./harness.js";
import { doerConfig } from "./doer.js";
const [command, homeArg, ...args] = process.argv.slice(2);
const reflectionUsage = "reflect HOME [--apply [ID] | --status | --list | --preview ID | --discard ID | --retry ID]";
function reflectionSignal() {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
async function main() {
  if (command === "doer-worker" && homeArg === "--protocol") {
    console.log("betta-doer/1");
    return;
  }
  if (command === "worker" || command === "doer-worker") {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort(new Error("Worker cancelled")));
    const input = JSON.parse(raw) as RunInput & { agentName?: string };
    if (command === "doer-worker") {
      if (!doerConfig() || !process.env.DOER_RUN_ID || input.requestId !== process.env.DOER_RUN_ID)
        throw new Error("Betta requires an authenticated Doer run with a matching request ID.");
      if (!input.model || !input.agentName) throw new Error("Betta requires an agent name and provider/model.");
      await initHome(input.home, input.agentName, input.model);
      input.costReporter = "adapter";
    }
    await runAgent(input, event => process.stdout.write(JSON.stringify(event) + "\n"), undefined, controller.signal);
    return;
  }
  if (!homeArg || !["init", "chat", "run", "sessions", "resume", "export", "inspect", "memory", "reflect", "memory-import"].includes(command || "")) {
    console.log(`DIS Betta Agent Harness\n\ninit HOME NAME PROVIDER/MODEL\nchat HOME\nrun HOME PROMPT [REQUEST_ID] [--session ID]\nsessions HOME\nresume HOME\ninspect HOME\nexport HOME DESTINATION [--continuation] [--history]\nmemory HOME COMMAND [ARGS]\n${reflectionUsage}\nmemory-import BUNDLE NEW_HOME NAME PROVIDER/MODEL\n\nSet provider API keys in your environment. Agent files contain no credentials.\nUse /settings and /permissions in chat to configure tools, connections, and runtime.`);
    return;
  }
  const home = path.resolve(homeArg);
  if (command === "memory") {
    const result=await memoryCommand(home,args[0]||'status',args.slice(1)); console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
  } else if (command === "reflect") {
    const proposalActions = ["--retry", "--discard", "--preview"] as const;
    const proposalAction = proposalActions.find(action => args.includes(action));
    if (proposalAction) {
      const conflict = args.find(arg => arg !== proposalAction &&
        (proposalActions.some(action => action === arg) || ["--apply", "--status", "--list"].includes(arg)));
      if (conflict) throw new Error(`Cannot combine ${proposalAction} and ${conflict}.`);
      const [flag, id] = args;
      if (args.length !== 2 || flag !== proposalAction || !id?.trim() || id.startsWith("-")) {
        throw new Error(`${proposalAction} requires exactly one proposal ID. Usage: ${reflectionUsage}`);
      }
      const actions = {
        "--retry": () => retryReflection(home, id, reflectionSignal()),
        "--discard": () => discardReflection(home, id),
        "--preview": () => previewReflection(home, id),
      };
      console.log(JSON.stringify(await actions[proposalAction](), null, 2));
      return;
    }
    const [flag, id] = args;
    if (flag === "--apply" && id !== undefined && !id.startsWith("-")) {
      const conflict = args.find(arg => arg === "--status" || arg === "--list");
      if (conflict) throw new Error(`Cannot combine ${conflict} and --apply.`);
      if (args.length !== 2 || !id.trim()) {
        throw new Error(`--apply accepts at most one proposal ID. Usage: ${reflectionUsage}`);
      }
      console.log(JSON.stringify(await applyReflection(home, id), null, 2));
      return;
    }
    const unknownArgument = args.find(arg => arg !== "--apply" && arg !== "--status" && arg !== "--list");
    if (unknownArgument !== undefined) {
      throw new Error(`Unknown reflection argument ${JSON.stringify(unknownArgument)}. Usage: ${reflectionUsage}`);
    }
    if (args.includes("--list")) {
      if (args.includes("--apply")) throw new Error("Cannot combine --list and --apply.");
      if (args.includes("--status")) throw new Error("Cannot combine --list and --status.");
      console.log(JSON.stringify(await proposals(home), null, 2));
      return;
    }
    if (args.includes("--status")) {
      if (args.includes("--apply")) throw new Error("Cannot combine --status and --apply.");
      console.log(JSON.stringify(await reflectionStatus(home), null, 2));
      return;
    }
    const proposal=await reflect(home,undefined,reflectionSignal());
    console.log(JSON.stringify(args.includes('--apply')&&proposal.status==='ready'?await applyReflection(home,proposal.id):proposal.id==='none'?proposal:await previewReflection(home,proposal.id),null,2));
  } else if (command === "memory-import") {
    if(args.length<3)throw new Error('memory-import BUNDLE NEW_HOME NAME PROVIDER/MODEL');
    console.log(JSON.stringify(await importMemoryBundle(home,args[0],args[1],args[2]),null,2));
  } else if (command === "init") {
    if (!args[0] || !args[1]) throw new Error("init requires a name and provider/model");
    console.log(JSON.stringify(await initHome(home, args[0], args[1]), null, 2));
  } else if (command === "export") {
    if (!args[0]) throw new Error("export requires a destination");
    await exportHome(home, args[0], args.includes("--continuation"), args.includes("--history"));
    console.log(`Exported to ${path.resolve(args[0])}`);
  } else if (command === "inspect") {
    console.log(JSON.stringify(await readManifest(home), null, 2));
    console.log(await fs.readFile(path.join(home, "memory", "MEMORY.md"), "utf8"));
  } else if (command === "sessions") {
    console.log(JSON.stringify(await listSessions(home), null, 2));
  } else if (command === "chat") {
    await chat(home);
  } else {
    // Under Doer's process adapter: take the request id from the Doer run, honor Doer's stop signal, and log
    // integration events to stderr (Doer keeps stdout and stderr as the run log).
    const doer = doerConfig();
    const controller = new AbortController();
    if (doer) process.once("SIGTERM", () => controller.abort(new Error("Run cancelled by Doer")));
    const sessionIndex = args[1] === '--session' ? 1 : args[2] === '--session' ? 2 : -1;
    const session = sessionIndex < 0 ? undefined : args[sessionIndex + 1];
    if (sessionIndex >= 0 && (!session || args.length !== sessionIndex + 2 || command !== 'run')) {
      throw new Error('Usage: run HOME PROMPT [REQUEST_ID] [--session ID]');
    }
    const requestId = sessionIndex === 1 ? undefined : args[1];
    const result = await runAgent({ home, prompt: args[0], requestId: requestId || (doer ? undefined : randomUUID()), session, resumeOnly: command === "resume" },
      event => {
        if (event.type === "recovery" && (command === "resume" || (command === "run" && !doer))) {
          console.error(`Recovering interrupted run ${event.requestId}`);
        }
        if (doer && event.type === "doer") console.error(`[doer] ${JSON.stringify(event)}`);
        const progress = providerProgressText(event);
        if (progress) console.error(progress);
      }, undefined, doer ? controller.signal : undefined);
    console.log(result.summary);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
