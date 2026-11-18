import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
const exec = promisify(execFile);
type Cli = 'agent-browser' | 'agent-desktop';
export async function automationExecutable(name: Cli) {
  const local = path.join(os.homedir(), '.local', 'bin', name);
  try { await fs.access(local); return local; } catch { return name; }
}
/** Subcommand names parsed from `<cli> --help` ("Commands:" section), cached per executable. */
const commandCache = new Map<string, Promise<string[]>>();
export function parseCommands(help: string): string[] {
  const start = help.search(/^Commands:\s*$/m); if (start < 0) return [];
  const names: string[] = [];
  for (const line of help.slice(start).split('\n').slice(1)) {
    const m = /^ {2}([a-z][\w-]*)\s/.exec(line); if (m) names.push(m[1]); else if (line.trim() && !line.startsWith(' ')) break;
  }
  return names;
}
function commandsOf(exe: string, cwd: string) {
  if (!commandCache.has(exe)) commandCache.set(exe, exec(exe, ['--help'], { cwd, timeout: 10000, encoding: 'utf8' })
    .then(r => parseCommands(r.stdout), (e: { stdout?: string }) => parseCommands(e.stdout || '')));
  return commandCache.get(exe)!;
}
const purpose = {
  'agent-browser': { what: 'browser', guide: 'core', examples: 'open, snapshot, click, fill' },
  'agent-desktop': { what: 'native desktop app UI', guide: 'desktop', examples: 'status, snapshot, find, click, type, launch' },
};
export function automationTool(name: Cli, cwd: string) {
  const p = purpose[name];
  return defineTool({ name: name.replace('-', '_'),
    description: `Run the Vercel ${name} CLI for ${p.what} automation. This is NOT a shell: args[0] must be one of its own subcommands (e.g. ${p.examples}); shell commands such as touch, cp, mkdir or open -a are rejected. Use file or shell tools for files and processes. Before first use, load the installed guide with args ["skills","get","${p.guide}"]; use ["<command>","--help"] for flags.`,
    parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1 }), timeoutSeconds: Type.Optional(Type.Integer({ minimum:1, maximum:300 })) }),
    replay: 'unsafe', outputLimits: { maxBytes: 64000, maxLines: 1200 },
    execute: async (args, _api, context) => {
      const exe = await automationExecutable(name);
      let stdout = '', stderr = '', failed: Error | undefined;
      try {
        ({ stdout, stderr } = await exec(exe, args.args, { cwd, signal: context.abortSignal, timeout: (args.timeoutSeconds ?? 60)*1000, maxBuffer: 1024*1024, encoding:'utf8' }));
      } catch (error) {
        const e = error as Error & { stdout?: string; stderr?: string; code?: string };
        stdout = e.stdout || ''; stderr = e.stderr || '';
        if (e.code === 'ENOENT') return { isError: true, output: [{ type:'text' as const, text: `${name} is not installed on this worker (looked in ~/.local/bin and PATH).` }] };
        failed = e;
      }
      let envelope: { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
      try { envelope = JSON.parse(stdout); } catch { /* text CLI output */ }
      // An unknown subcommand means the model guessed: answer with the real command list instead of letting it keep guessing.
      if (envelope?.error?.code === 'INVALID_ARGS' && /unrecognized subcommand/.test(envelope.error.message || '')) {
        const commands = await commandsOf(exe, cwd);
        return { isError: true, output: [{ type:'text' as const, text: `"${args.args[0]}" is not an ${name} command; this tool is not a shell. Nothing was executed.${commands.length ? ` Valid commands: ${commands.join(', ')}.` : ''} For files or processes use the file or shell tools; for ${name} usage load args ["skills","get","${p.guide}"].` }] };
      }
      const text = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || (failed ? failed.message : '');
      return { isError: Boolean(failed) || envelope?.ok === false, output: [{ type:'text' as const, text }] };
    }
  });
}
