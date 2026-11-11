import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface AgentManifest {
  version: 1;
  id: string;
  name: string;
  model: string;
  instructions: string;
  allowShell: boolean;
}
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function readManifest(home: string): Promise<AgentManifest> {
  const value = JSON.parse(await fs.readFile(path.join(home, "agent.json"), "utf8"));
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.name !== "string" ||
      typeof value.model !== "string" || !value.model.includes("/") || typeof value.instructions !== "string" ||
      typeof value.allowShell !== "boolean") throw new Error("Invalid agent.json (expected manifest version 1)");
  return { version: 1, id: value.id, name: value.name, model: value.model, instructions: value.instructions, allowShell: value.allowShell };
}

// SQLite owns the OS lock: process death releases it without stale PID files or lock stealing.
export async function lockHome(home: string): Promise<() => void> {
  await fs.mkdir(path.join(home, "state"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, "state", "owner.sqlite"));
  try { db.exec("BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("Agent is busy in another process. Try again when that run finishes."); }
  return () => { db.exec("ROLLBACK"); db.close(); };
}

export async function initHome(home: string, name: string, model: string): Promise<AgentManifest> {
  await fs.mkdir(home, { recursive: true });
  const release = await lockHome(home);
  try {
    try { return await readManifest(home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!model.includes("/")) throw new Error("Model must be provider/model-id");
    const manifest: AgentManifest = { version: 1, id: randomUUID(), name, model,
      instructions: "Be a thoughtful, capable assistant. Keep durable knowledge accurate and concise.", allowShell: false };
    await fs.mkdir(path.join(home, "memory"), { recursive: true });
    await fs.mkdir(path.join(home, "skills"), { recursive: true });
    await fs.writeFile(path.join(home, "agent.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    for (const [file, content] of Object.entries({
      "MEMORY.md": "# Memory\n\nCore: persona.md, human.md\nReference: create indexed subdirectories as knowledge grows.\n",
      "persona.md": `# Identity\n\nI am ${name}.\n`,
      "human.md": "# Person I work with\n\nRecord durable preferences here when learned.\n",
    })) {
      try { await fs.writeFile(path.join(home, "memory", file), content, { flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await commitMemory(path.join(home, "memory"), "Initialize memory");
    return manifest;
  } finally { release(); }
}

export async function commitMemory(root: string, message: string): Promise<void> {
  const git = (...args: string[]) => exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  try { await fs.access(path.join(root, ".git")); } catch { await git("init", "--quiet"); }
  await git("add", "--", ".");
  const { stdout } = await git("status", "--porcelain");
  if (stdout.trim()) await git("-c", "user.name=Agent Memory", "-c", "user.email=memory@localhost", "commit", "--quiet", "-m", message);
}

export async function memoryPath(root: string, relative: string): Promise<string> {
  if (!relative.endsWith(".md") || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === ".." || p.startsWith("."))) {
    throw new Error("Memory paths must be relative Markdown paths without hidden or parent components");
  }
  const base = await fs.realpath(root);
  const parts = relative.split(/[\\/]/);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Memory symlinks are not supported"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

export async function readMemory(root: string, relative: string) {
  const file = await memoryPath(root, relative);
  try {
    if ((await fs.stat(file)).size > 128_000) throw new Error("Memory file exceeds 128 KB; split it into smaller files");
    const content = await fs.readFile(file, "utf8");
    return { content, sha256: hash(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", sha256: "missing" };
    throw error;
  }
}

export async function writeMemory(root: string, relative: string, content: string, expectedHash: string) {
  if (Buffer.byteLength(content) > 128_000) throw new Error("Memory file exceeds 128 KB");
  const file = await memoryPath(root, relative);
  const old = await readMemory(root, relative);
  // An interrupted replay of an already-applied replacement is a no-op.
  if (old.sha256 === hash(content)) return old;
  if (old.sha256 !== expectedHash) throw new Error("Memory changed since you read it; read again before updating");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx");
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  return { content, sha256: hash(content) };
}

export async function coreMemory(root: string): Promise<string> {
  const sections: string[] = [];
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md")) sections.push(`## ${entry.name}\n${(await readMemory(root, entry.name)).content}`);
  }
  const content = sections.join("\n\n");
  if (content.length > 24_000) throw new Error("Core memory exceeds 24,000 characters. Move reference material into subdirectories.");
  return content;
}

export async function exportHome(home: string, destination: string, continuation: boolean): Promise<void> {
  home = await fs.realpath(home);
  destination = path.join(await fs.realpath(path.dirname(path.resolve(destination))), path.basename(destination));
  if (destination === home || destination.startsWith(home + path.sep)) throw new Error("Export destination must be outside the agent home");
  const release = await lockHome(home);
  try {
    const manifest = await readManifest(home);
    // Require a new directory so a failed or repeated export cannot overwrite an agent.
    await fs.mkdir(destination);
    const copyTree = async (source: string, target: string): Promise<void> => {
      await fs.mkdir(target, { recursive: true });
      for (const item of await fs.readdir(source, { withFileTypes: true })) {
        if (item.name.startsWith(".")) continue;
        if (item.isSymbolicLink()) throw new Error(`Export refuses symlink: ${item.name}`);
        const from = path.join(source, item.name), to = path.join(target, item.name);
        if (item.isDirectory()) await copyTree(from, to);
        else if (item.isFile()) await fs.copyFile(from, to);
      }
    };
    await copyTree(path.join(home, "memory"), path.join(destination, "memory"));
    await copyTree(path.join(home, "skills"), path.join(destination, "skills"));
    // Settings travel with the agent; local connections require explicit activation on the receiving machine.
    try {
      const settings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
      settings.connections = (settings.connections || []).map((c: Record<string, unknown>) => ({ ...c, enabled: false }));
      settings.permissions.mcp = false;
      if (!continuation) delete settings.cwd;
      await fs.writeFile(path.join(destination, "settings.json"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!continuation) manifest.id = randomUUID();
    await fs.writeFile(path.join(destination, "agent.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (continuation) {
      const source = path.join(home, "state", "runtime.sqlite");
      await fs.access(source);
      await fs.mkdir(path.join(destination, "state"));
      try { await fs.copyFile(path.join(home, "state", "actions.jsonl"), path.join(destination, "state", "actions.jsonl")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(source);
      try { db.exec(`VACUUM INTO '${path.join(destination, "state", "runtime.sqlite").replaceAll("'", "''")}'`); }
      finally { db.close(); }
    }
    await commitMemory(path.join(destination, "memory"), "Imported agent memory snapshot");
  } finally { release(); }
}
