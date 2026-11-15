#!/usr/bin/env node
import { memoryCommand, importMemoryBundle } from "./memory-service.js";
import { reflect, applyReflection, previewReflection } from "./reflection.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chat } from "./chat.js";
import { initHome, readManifest, exportHome } from "./home.js";
import { runAgent, type RunInput } from "./harness.js";
import { doerConfig } from "./doer.js";
const [command, homeArg, ...args] = process.argv.slice(2);
async function main() {
  if (command === "worker") {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort(new Error("Worker cancelled")));
    await runAgent(JSON.parse(raw) as RunInput, event => process.stdout.write(JSON.stringify(event) + "\n"), undefined, controller.signal);
    return;
  }
  if (!homeArg || !["init", "chat", "run", "resume", "export", "inspect", "memory", "reflect", "memory-import"].includes(command || "")) {
    console.log(`Donjon durable agent\n\ninit HOME NAME PROVIDER/MODEL\nchat HOME\nrun HOME PROMPT [REQUEST_ID]\nresume HOME\ninspect HOME\nexport HOME DESTINATION [--continuation] [--history]\nmemory HOME COMMAND [ARGS]\nreflect HOME [--apply]\nmemory-import BUNDLE NEW_HOME NAME PROVIDER/MODEL\n\nSet provider API keys in your environment. Agent files contain no credentials.\nUse /settings and /permissions in chat to configure tools, connections, and runtime.`);
    return;
  }
  const home = path.resolve(homeArg);
  if (command === "memory") {
    const result=await memoryCommand(home,args[0]||'status',args.slice(1)); console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
  } else if (command === "reflect") {
    const controller=new AbortController(); process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
    const proposal=await reflect(home,undefined,controller.signal);
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
  } else if (command === "chat") {
    await chat(home);
  } else {
    // Under Doer's process adapter: take the request id from the Doer run, honor Doer's stop signal, and log
    // integration events to stderr (Doer keeps stdout and stderr as the run log). Standalone is unchanged.
    const doer = doerConfig();
    const controller = new AbortController();
    if (doer) process.once("SIGTERM", () => controller.abort(new Error("Run cancelled by Doer")));
    const result = await runAgent({ home, prompt: args[0], requestId: args[1] || (doer ? undefined : randomUUID()), resumeOnly: command === "resume" },
      doer ? event => { if (event.type === "doer") console.error(`[doer] ${JSON.stringify(event)}`); } : undefined, undefined, doer ? controller.signal : undefined);
    console.log(result.summary);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
