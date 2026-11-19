import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockHome, readManifest } from './home.js';
export interface Connection {
  name: string; transport: 'stdio' | 'http'; enabled: boolean;
  command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; bearerEnv?: string;
}
export interface AgentSettings {
  version: 1; cwd?: string; maxTurns: number; compaction: boolean; timeoutSeconds: number;
  maxTurnsMigrated?: true;
  permissions: { shell: boolean; files: boolean; mcp: boolean; network?: boolean; browser?: boolean; desktop?: boolean };
  connections: Connection[];
}
/** Tool rounds per request. 50 was the old default and cut off ordinary multi-file work; saved 50s move up once on read. */
export const DEFAULT_MAX_TURNS = 150;
export interface AppSettings { version: 1; theme: 'magic' | 'purple' | 'plain'; banner: boolean; agentHomes: string[]; look?: 2 }
export const configRoot = () => process.env.DONJON_CONFIG_DIR || path.join(os.homedir(), '.donjon');
async function json(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
}
export function validateSettings(s: AgentSettings): AgentSettings {
  if (s.version !== 1 || !Number.isInteger(s.maxTurns) || s.maxTurns < 1 || s.maxTurns > 1000 ||
      !Number.isInteger(s.timeoutSeconds) || s.timeoutSeconds < 0 || s.timeoutSeconds > 86400 ||
      typeof s.compaction !== 'boolean' || (s.cwd !== undefined && (typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd))) ||
      !s.permissions || ['shell','files','mcp'].some(k => typeof s.permissions[k as keyof AgentSettings['permissions']] !== 'boolean') ||
      (['network','browser','desktop'] as const).some(k => s.permissions[k] !== undefined && typeof s.permissions[k] !== 'boolean') ||
      !Array.isArray(s.connections)) throw new Error('Invalid agent settings');
  const names = new Set<string>();
  for (const c of s.connections) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(c.name) || names.has(c.name) || typeof c.enabled !== 'boolean') throw new Error('Connection names must be unique letters, digits, dashes or underscores');
    names.add(c.name);
    if (c.transport === 'stdio') {
      if (typeof c.command !== 'string' || !c.command.trim() || (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(a => typeof a !== 'string')))) throw new Error('Stdio connections require a command and string arguments');
    } else if (c.transport === 'http') {
      const u = new URL(c.url || '');
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without embedded credentials');
    } else throw new Error('Unknown connection transport');
    if (c.env && (typeof c.env !== 'object' || Array.isArray(c.env) || Object.entries(c.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))) throw new Error('Connection env maps server variable names to local environment variable names');
    if (c.bearerEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.bearerEnv)) throw new Error('Bearer auth requires an environment variable name');
  }
  return s;
}
export async function readSettings(home: string): Promise<AgentSettings> {
  const manifest = await readManifest(home);
  const file = path.join(home, 'settings.json');
  let saved = await json(file) as AgentSettings | undefined;
  if (saved?.maxTurns === 50 && saved.maxTurnsMigrated !== true) {
    const release = await lockHome(home);
    try {
      saved = await json(file) as AgentSettings | undefined;
      if (saved?.maxTurns === 50 && saved.maxTurnsMigrated !== true) {
        saved = validateSettings({ ...saved, maxTurns: DEFAULT_MAX_TURNS, maxTurnsMigrated: true });
        await atomicJson(file, saved);
      }
    } finally { release(); }
  }
  return validateSettings(saved ?? {
    version: 1, maxTurns: DEFAULT_MAX_TURNS, compaction: true, timeoutSeconds: 0,
    permissions: { shell: manifest.allowShell, files: manifest.allowShell, mcp: false, network: false }, connections: [],
  });
}
export async function saveSettings(home: string, settings: AgentSettings) {
  validateSettings(settings);
  const release = await lockHome(home);
  try { await atomicJson(path.join(home, 'settings.json'), { ...settings, maxTurnsMigrated: true }); } finally { release(); }
}
export async function readApp(): Promise<AppSettings> {
  const s = await json(path.join(configRoot(), 'settings.json')) ?? { version: 1, theme: 'magic', banner: true, agentHomes: [], look: 2 };
  if (s.version !== 1 || !['magic','purple','plain'].includes(s.theme) || typeof s.banner !== 'boolean' || !Array.isArray(s.agentHomes) || s.agentHomes.some((h: unknown) => typeof h !== 'string') || (s.look !== undefined && s.look !== 2)) throw new Error('Invalid application settings');
  // Settings saved before the Magic City look carried the old default; move them over once. /theme purple restores it.
  if (s.look !== 2) { if (s.theme === 'purple') s.theme = 'magic'; s.look = 2; }
  return s;
}
export async function saveApp(app: AppSettings) { await atomicJson(path.join(configRoot(), 'settings.json'), app); }
export async function listAgents(current: string, app: AppSettings) {
  const roots = new Set([path.dirname(current), path.join(configRoot(), 'agents')]);
  const homes = new Set([current, ...app.agentHomes]);
  for (const root of roots) {
    try { for (const d of await fs.readdir(root, { withFileTypes: true })) if (d.isDirectory()) homes.add(path.join(root, d.name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const agents: { home: string; manifest: Awaited<ReturnType<typeof readManifest>> }[] = [];
  for (const home of homes) {
    try { agents.push({ home: await fs.realpath(home), manifest: await readManifest(home) }); } catch { /* Non-agent directories are not listed. */ }
  }
  return agents.filter((a,i) => agents.findIndex(b => a.home === b.home) === i).sort((a,b) => a.manifest.name.localeCompare(b.manifest.name));
}
