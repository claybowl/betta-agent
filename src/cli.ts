#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { initHome, readManifest, exportHome } from "./home.js";
import { runAgent, type RunInput } from "./harness.js";
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
  if (!homeArg || !["init", "chat", "run", "resume", "export", "inspect"].includes(command || "")) {
    console.log(`Donjon durable agent\n\ninit HOME NAME PROVIDER/MODEL\nchat HOME\nrun HOME PROMPT [REQUEST_ID]\nresume HOME\ninspect HOME\nexport HOME DESTINATION [--continuation]\n\nSet provider API keys in your environment. Agent files contain no credentials.\nSet allowShell=true in agent.json to enable shell and file-writing tools.`);
    return;
  }
  const home = path.resolve(homeArg);
  if (command === "init") {
    if (!args[0] || !args[1]) throw new Error("init requires a name and provider/model");
    console.log(JSON.stringify(await initHome(home, args[0], args[1]), null, 2));
  } else if (command === "export") {
    if (!args[0]) throw new Error("export requires a destination");
    await exportHome(home, args[0], args.includes("--continuation"));
    console.log(`Exported to ${path.resolve(args[0])}`);
  } else if (command === "inspect") {
    console.log(JSON.stringify(await readManifest(home), null, 2));
    console.log(await fs.readFile(path.join(home, "memory", "MEMORY.md"), "utf8"));
  } else if (command === "chat") {
    const manifest = await readManifest(home);
    console.log(`${manifest.name} · durable memory · /exit to leave · /resume to recover unfinished work`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const prompt = (await rl.question("You > ")).trim();
        if (prompt === "/exit") break;
        if (!prompt) continue;
        try {
          const result = await runAgent({ home, prompt, requestId: randomUUID(), resumeOnly: prompt === "/resume" });
          console.log(`\n${manifest.name} > ${result.summary}\n`);
        } catch (error) { console.error(error instanceof Error ? error.message : error); }
      }
    } finally { rl.close(); }
  } else {
    const result = await runAgent({ home, prompt: args[0], requestId: args[1] || randomUUID(), resumeOnly: command === "resume" });
    console.log(result.summary);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
