import { memoryCommand } from './memory-service.js';
import { reflect, previewReflection, proposals, applyReflection, discardReflection, retryReflection, reflectionSettings } from './reflection.js';
import { saveState } from './memfs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { readManifest, initHome, lockHome } from './home.js';
import { runAgent, type Emit } from './harness.js';
import { readApp, saveApp, readSettings, saveSettings, listAgents, atomicJson, type AgentSettings, type Connection } from './settings.js';
import { listSkills, readSkill } from './skills.js';
import { readActions } from './activity.js';
import { Connections } from './connections.js';
import { stripVTControlCharacters } from 'node:util';
export const cleanText = (value: unknown) => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const commands = ['/help','/memory','/reflect','/settings','/permissions','/runtime','/app','/connections','/agents','/agent','/new','/cwd','/skills','/skill','/use','/actions','/resume','/clear','/exit'];
const expand = (s: string) => path.resolve(s.replace(/^~(?=\/|$)/, os.homedir()));
export async function chat(initialHome: string) {
  let home = await fs.realpath(initialHome), app = await readApp();
  let manifest = await readManifest(home), settings = await readSettings(home);
  const connections = new Connections();
  let history: string[] = [], leaving = false;
  const color = (code: string, text: unknown) => process.stdout.isTTY && app.theme !== 'plain' && !process.env.NO_COLOR ? `\x1b[${code}m${cleanText(text)}\x1b[0m` : cleanText(text);
  const purple = (s: unknown) => color('38;5;99', s), dim = (s: unknown) => color('38;5;245', s);
  const line = (s = '') => console.log(cleanText(s));
  const panel = (title: string) => console.log('\n' + purple('── ' + title + ' ' + '─'.repeat(Math.max(1, Math.min(process.stdout.columns || 70, 80) - title.length - 5))));
  // Keep a single iterator in pipe mode so scripted input is never discarded between prompts.
  const piped = !process.stdin.isTTY ? createInterface({ input: process.stdin, terminal: false }) : undefined;
  const iterator = piped?.[Symbol.asyncIterator]();
  const ask = async (label: string): Promise<string> => {
    if (iterator) { const next = await iterator.next(); if (next.done) { leaving = true; return ''; } return next.value.trim(); }
    const rl = createInterface({ input: process.stdin, output: process.stdout, history, completer: text => [commands.filter(c => c.startsWith(text)), text] });
    const abort = new AbortController();
    rl.once('SIGINT', () => { leaving = true; abort.abort(); });
    try { return (await rl.question(purple(label), { signal: abort.signal })).trim(); }
    catch (e) { if (abort.signal.aborted) return ''; throw e; }
    finally { history = [...(rl as unknown as { history: string[] }).history]; rl.close(); }
  };
  const remember = async () => { if (!app.agentHomes.includes(home)) { app.agentHomes.push(home); await saveApp(app); } };
  const save = async () => { await saveSettings(home, settings); await connections.close(); };
  const status = () => console.log(`${purple(manifest.name)} ${dim('· ' + manifest.model + '\n' + (settings.cwd || home) + '\n/help' + '  ·  Tab completes commands  ·  Esc stops a running turn')}`);
  const banner = () => {
    if (app.banner) console.log(purple(String.raw`
   ____   ___  ____
  |  _ \ |_ _|/ ___|
  | | | | | | \___ \
  | |_| | | |  ___) |
  |____/ |___||____/

  Donjon Intelligence Systems
`));
    status();
  };
  const showActions = () => {
    panel('Action history');
    const actions = readActions(home).slice(-20);
    if (!actions.length) line('No recorded actions yet.');
    for (const a of actions) console.log(`${a.status === 'completed' ? color('38;5;108', '✓') : color('38;5;179', '?')} ${cleanText(a.status)}  ${cleanText(a.name)}  ${dim(a.time)}\n  ${dim(a.detail || '')}`);
    line('Completed = tool returned a result. Error or unknown can still mean partial changes. Escape does not undo effects.');
  };
  const permissions = async () => {
    panel('Permissions · ' + manifest.name);
    line('Shell runs local commands. Files permits write/edit. MCP permits enabled server connections and tools.\nMemory tools remain enabled. These are tool access switches, not an operating-system sandbox; shell tools can also modify files.');
    for (const [k,v] of Object.entries(settings.permissions)) line(`${k.padEnd(8)} ${v ? 'on' : 'off'}`);
    const answer = await ask('Change: shell|files|mcp on|off (Enter returns) > ');
    if (!answer) return;
    const [key, value] = answer.split(/\s+/);
    if (!['shell','files','mcp'].includes(key) || !['on','off'].includes(value)) throw new Error('Example: shell on');
    settings.permissions[key as keyof AgentSettings['permissions']] = value === 'on'; await save(); line('Permission saved.');
  };
  const runtime = async () => {
    panel('Runtime · ' + manifest.name);
    line(`model        ${manifest.model}\nmaxTurns     ${settings.maxTurns}\ncompaction   ${settings.compaction ? 'on' : 'off'}\ntimeout      ${settings.timeoutSeconds}s (0 = unlimited)\nRecovery resumes unfinished work on the next run. Escape cancels the current turn.`);
    const answer = await ask('Change: model PROVIDER/ID | maxTurns N | compaction on|off | timeout SECONDS (Enter returns) > ');
    if (!answer) return;
    const [key,value] = answer.split(/\s+/);
    if (key === 'model') {
      if (!value || value.indexOf('/') < 1 || value.endsWith('/')) throw new Error('Model must be provider/model-id');
      const release = await lockHome(home);
      try { manifest = { ...await readManifest(home), model: value }; await atomicJson(path.join(home, 'agent.json'), manifest); }
      finally { release(); }
      line('Model saved. Pending work must be resumed with its original model.'); return;
    }
    if (key === 'maxTurns') settings.maxTurns = Number(value);
    else if (key === 'timeout') settings.timeoutSeconds = Number(value);
    else if (key === 'compaction' && ['on','off'].includes(value)) settings.compaction = value === 'on';
    else throw new Error('Unknown runtime setting');
    await save(); line('Runtime settings saved.');
  };
  const appearance = async () => {
    panel('Application'); line(`theme    ${app.theme}\nbanner   ${app.banner ? 'on' : 'off'}`);
    const answer = await ask('Change: theme purple|plain | banner on|off (Enter returns) > ');
    if (!answer) return;
    const [key,value] = answer.split(/\s+/);
    if (key === 'theme' && ['purple','plain'].includes(value)) app.theme = value as 'purple' | 'plain';
    else if (key === 'banner' && ['on','off'].includes(value)) app.banner = value === 'on';
    else throw new Error('Unknown application setting');
    await saveApp(app); line('Application settings saved.');
  };
  const changeCwd = async (value?: string) => {
    const answer = value || await ask('Working directory (home resets; Enter returns) > ');
    if (!answer) return;
    if (answer === 'home') delete settings.cwd;
    else { const dir = await fs.realpath(expand(answer)); if (!(await fs.stat(dir)).isDirectory()) throw new Error('Choose a directory'); settings.cwd = dir; }
    await save(); line(`Working directory: ${settings.cwd || home}`);
  };
  const connectionMenu = async () => {
    panel('Connections');
    line(`MCP permission: ${settings.permissions.mcp ? 'on' : 'off'}. Active means connected in this session.`);
    for (const c of settings.connections) {
      line(`${c.name}  ${connections.status(c.name)}  ${c.enabled ? 'enabled' : 'disabled'}  ${c.transport}`);
      if (connections.errors.has(c.name)) line('  ' + connections.errors.get(c.name));
    }
    if (!settings.connections.length) line('No servers configured.');
    const answer = await ask('add | connect | enable NAME | disable NAME | remove NAME | tools (Enter returns) > ');
    const [action,name] = answer.split(/\s+/);
    if (!answer) return;
    if (action === 'add') {
      const name = await ask('Server name > '); if (!name) return;
      const transport = await ask('Transport: stdio or http > ');
      const c: Connection = { name, transport: transport as Connection['transport'], enabled: false };
      if (transport === 'stdio') {
        c.command = await ask('Executable (e.g. npx; no shell command string) > ');
        c.args = JSON.parse((await ask('Arguments as JSON array (Enter = []) > ')) || '[]');
        c.env = JSON.parse((await ask('Environment mapping as JSON, e.g. {"API_KEY":"MY_API_KEY"} (Enter = {}) > ')) || '{}');
      } else if (transport === 'http') {
        c.url = await ask('Server URL > ');
        c.bearerEnv = (await ask('Bearer-token environment variable name (Enter = none) > ')) || undefined;
      } else throw new Error('Choose stdio or http');
      settings.connections.push(c); await save(); line('Server added, disabled. Enable it and turn MCP permission on to connect.');
    } else if (action === 'connect') {
      if (!settings.permissions.mcp) throw new Error('Enable MCP in /permissions first');
      await connections.sync(settings, settings.cwd || home, render);
      for (const c of settings.connections) line(`${c.name}: ${connections.status(c.name)}`);
    } else if (action === 'tools') {
      for (const tool of connections.tools()) line(`${tool.name} — ${tool.description}`);
      if (!connections.tools().length) line('No connected tools.');
    } else {
      const c = settings.connections.find(c => c.name === name); if (!c) throw new Error('Unknown connection');
      if (action === 'remove') settings.connections = settings.connections.filter(c => c.name !== name);
      else if (action === 'enable' || action === 'disable') c.enabled = action === 'enable';
      else throw new Error('Unknown connection command');
      await save(); line('Connections saved.');
    }
  };
  const switchAgent = async (arg?: string) => {
    const agents = await listAgents(home, app);
    if (!arg) { panel('Agents'); agents.forEach((a,i) => line(`${i+1}. ${a.manifest.name}${a.home === home ? ' · current' : ''}\n   ${a.home}`)); }
    const choice = arg || await ask('Agent number, name, or home path (Enter returns) > '); if (!choice) return;
    const matches = agents.filter(a => a.manifest.name.toLowerCase() === choice.toLowerCase());
    if (matches.length > 1) throw new Error('More than one agent has that name; choose a number or path');
    const target = /^\d+$/.test(choice) ? agents[Number(choice)-1]?.home : matches[0]?.home || expand(choice);
    if (!target) throw new Error('Unknown agent');
    const nextHome = await fs.realpath(target), nextManifest = await readManifest(nextHome), nextSettings = await readSettings(nextHome);
    await connections.close(); home = nextHome; manifest = nextManifest; settings = nextSettings; await remember(); status();
  };
  const render: Emit = event => {
    if (event.type === 'command_start') { panel('Command'); line(Array.isArray(event.command) ? event.command.join(' ') : String(event.command)); console.log(dim(event.cwd)); }
    else if (event.type === 'command_output') process.stdout.write(cleanText(event.text));
    else if (event.type === 'command_end') console.log('\n' + dim(event.error ? `Stopped / uncertain: ${event.error}` : `Exit code: ${event.exitCode}`));
    else if (event.type === 'action' && event.status === 'started') console.log(dim(`\n› ${event.name} ${event.detail}`));
    else if (event.type === 'action' && event.status !== 'started') console.log(dim(`  ${event.status}: ${event.name}`));
    else if (event.type === 'tool_result' && event.name !== 'bash') {
      const output = event.output as { type: string; text?: string }[] | undefined;
      const text = output?.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text) line(text.length > 3000 ? text.slice(0,3000) + '\n… display truncated' : text);
    }
    else if (event.type === 'memory_active') console.log(dim(`Memory active: ${event.revision}${event.warning ? ' · '+event.warning : ''}`));
    else if (event.type === 'skill') console.log(purple(`Using skill: ${event.name}`));
    else if (event.type === 'recovery') console.log(color('38;5;179', `Recovering interrupted run ${event.requestId}`));
    else if (event.type === 'connection') console.log(dim(`MCP ${event.name}: ${event.status}${event.message ? ' · ' + event.message : ''}`));
    else if (event.type === 'connection_log') console.log(dim(`[${event.name}] ${event.text}`));
  };
  const run = async (prompt: string, resumeOnly = false, task?: (signal: AbortSignal) => Promise<string>) => {
    const controller = new AbortController();
    const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        if (!controller.signal.aborted) { console.log(color('38;5;179', '\nStopping…')); controller.abort(new Error('Stopped by user')); }
      }
    };
    const sigint = () => controller.abort(new Error('Stopped by user'));
    process.on('SIGINT', sigint);
    const raw = process.stdin.isRaw;
    if (process.stdin.isTTY) { emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.on('keypress', keypress); process.stdin.resume(); }
    try {
      console.log(dim('Working… Esc to stop'));
      if (task) { const text = await task(controller.signal); panel('Memory reflection'); line(text); return; }
      const result = await runAgent({ home, prompt, requestId: randomUUID(), resumeOnly }, render, undefined, controller.signal, connections);
      panel(manifest.name); line(result.summary); console.log(dim(`${result.usage.inputTokens} in · ${result.usage.outputTokens} out · $${result.costUsd.toFixed(4)}`));
    } catch (error) {
      if (controller.signal.aborted) { line('Turn stopped. Use /actions to inspect outcomes; /resume will not restart this cancelled turn.'); }
      else throw error;
    } finally {
      process.off('SIGINT', sigint);
      if (process.stdin.isTTY) { process.stdin.off('keypress', keypress); process.stdin.setRawMode(raw || false); process.stdin.pause(); }
    }
  };
  await remember(); banner();
  try {
    while (!leaving) {
      const prompt = await ask('\nYou › '); if (!prompt) continue;
      try {
        settings = await readSettings(home);
        if (!prompt.startsWith('/')) { await run(prompt); continue; }
        const space = prompt.indexOf(' '), cmd = space < 0 ? prompt : prompt.slice(0,space), arg = space < 0 ? '' : prompt.slice(space+1).trim();
        if (cmd === '/exit') break;
        else if (cmd === '/help') { panel('Command palette'); line('/settings       Browse settings\n/memory         Memory status, search, history, sync\n/reflect        Propose learning; list, apply ID, settings\n/permissions    Shell, file writes, MCP\n/runtime        Turn limit, compaction, timeout\n/app            Colors and startup banner\n/connections    Add and manage MCP servers\n/agents         Switch agents\n/agent NAME     Switch directly\n/new            Create an agent\n/cwd [PATH]     Choose working directory\n/skills         Installed skills\n/skill NAME     Read skill instructions\n/use NAME TASK  Ask agent to use a skill\n/actions        Recent tool outcomes\n/resume         Recover unfinished work\n/clear          Clear screen\n/exit           Leave harness'); }
        else if (cmd === '/memory') {
          panel('Memory');
          let parts = arg.split(/\s+/).filter(Boolean);
          if (!parts.length) { line(JSON.stringify(await memoryCommand(home,'status'),null,2)); line('status · browse · core · read PATH · search QUERY · recall QUERY · diff [REV] · history\nrefresh · migrate · commit REASON · revert REV · config [JSON] · bundle PATH · remote URL · push · pull'); parts=(await ask('Memory command (Enter returns) > ')).split(/\s+/).filter(Boolean); }
          if(parts.length) line(JSON.stringify(await memoryCommand(home,parts[0],parts.slice(1)),null,2));
        }
        else if (cmd === '/reflect') {
          const [action,id] = arg.split(/\s+/);
          if(!action || action==='preview') await run('',false,async signal=>{const p=id?await previewReflection(home,id):await reflect(home,undefined,signal);return JSON.stringify(p.id==='none'?p:await previewReflection(home,p.id),null,2);});
          else if(action==='list') line(JSON.stringify(await proposals(home),null,2));
          else if(action==='apply') line(JSON.stringify(await applyReflection(home,id),null,2));
          else if(action==='retry') await run('',false,async()=>JSON.stringify(await retryReflection(home,id),null,2));
          else if(action==='discard') line(JSON.stringify(await discardReflection(home,id),null,2));
          else if(action==='settings') {
            line(JSON.stringify(await reflectionSettings(home),null,2));
            const json=await ask('Reflection settings as JSON (Enter returns) > ');
            if(json) { const release=await lockHome(home);const prior=await reflectionSettings(home);try { await saveState(home,'reflection-settings.json',JSON.parse(json));try{await reflectionSettings(home);}catch(e){await saveState(home,'reflection-settings.json',prior);throw e;} }finally{release();}line('Reflection settings saved.'); }
          } else throw new Error('/reflect preview | list | apply ID | discard ID | retry ID | settings');
        }
        else if (cmd === '/permissions') await permissions();
        else if (cmd === '/runtime') await runtime();
        else if (cmd === '/app') await appearance();
        else if (cmd === '/cwd') await changeCwd(arg);
        else if (cmd === '/connections') await connectionMenu();
        else if (cmd === '/agents' || cmd === '/agent') await switchAgent(arg);
        else if (cmd === '/new') {
          const name = await ask('Agent name > '); if (!name) continue;
          const destination = await ask('New agent home path > '); if (!destination) continue;
          const model = await ask(`Provider/model (Enter = ${manifest.model}) > `);
          const target = expand(destination);
          try { await fs.access(path.join(target, 'agent.json')); throw new Error('That agent already exists; use /agent'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          await initHome(target, name, model || manifest.model); await switchAgent(target);
        }
        else if (cmd === '/skills') { panel('Skills'); const skills = await listSkills(home); for (const s of skills) line(`${s.name}\n  ${s.description}`); if (!skills.length) line(`No skills installed. Add a folder containing SKILL.md under ${path.join(home,'skills')}.`); line('/skill NAME reads instructions. /use NAME TASK requests a skill explicitly. Loaded skills appear in live activity and /actions.'); }
        else if (cmd === '/skill') { const skill = await readSkill(home,arg); panel(skill.name); line(skill.content); }
        else if (cmd === '/use') { const i = arg.indexOf(' '); if (i < 1) throw new Error('Usage: /use NAME TASK'); const name = arg.slice(0,i); await readSkill(home,name); await run(`Use the installed skill ${JSON.stringify(name)}. First load its instructions with skill_read. Task: ${arg.slice(i+1)}`); }
        else if (cmd === '/actions') showActions();
        else if (cmd === '/resume') await run('',true);
        else if (cmd === '/clear') { if (process.stdout.isTTY) console.clear(); status(); }
        else if (cmd === '/settings') {
          panel('Settings'); line('1  Permissions\n2  Runtime\n3  Working directory\n4  Connections\n5  Application\n6  Agents\n7  Skills\n8  Action history\n9  Memory\n10 Reflection budgets');
          const choice = await ask('Section (Enter returns) > ');
          if (choice === '1') await permissions(); else if (choice === '2') await runtime(); else if (choice === '3') await changeCwd(); else if (choice === '4') await connectionMenu(); else if (choice === '5') await appearance(); else if (choice === '6') await switchAgent(); else if (choice === '7') { for (const s of await listSkills(home)) line(`${s.name}: ${s.description}`); } else if (choice === '8') showActions(); else if (choice === '9') { line(JSON.stringify(await memoryCommand(home,'status'),null,2)); line('Use /memory to browse and configure memory.'); } else if (choice === '10') { line(JSON.stringify(await reflectionSettings(home),null,2)); line('Use /reflect settings to adjust budgets.'); }
        } else throw new Error('Unknown slash command. Use /help.');
      } catch (error) { console.log(color('38;5;174', error instanceof Error ? error.message : error)); }
    }
  } finally { await connections.close(); piped?.close(); }
}
