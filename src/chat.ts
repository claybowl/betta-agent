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
import { readApp, saveApp, readSettings, saveSettings, listAgents, atomicJson, configRoot, type AgentSettings, type Connection } from './settings.js';
import { inspectSkills, readSkill } from './skills.js';
import { readActions } from './activity.js';
import { capabilityReport } from './connectivity.js';
import { Connections } from './connections.js';
import { clean, toolPreview, makeTheme, themeNames, themeLabels, rule, banner as wordmark, playBanner, readLine, pick, spinner, type Command, type PickItem, type ThemeName } from './tui.js';
import { appModels, deviceId, subscriptionBlocked, FileCredentialStore } from './credentials.js';
import { parseGoal, goalStatus, goalPrompt } from './goal.js';
import { spawn } from 'node:child_process';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { keyEnvVar, streamModels, checkModel, explainRunError, type ModelChoice, type ModelCheck } from './model-list.js';
export const cleanText = clean;
const commandList: Command[] = [
  { name: '/help', description: 'Command palette' },
  { name: '/model', description: 'Choose a model from the live provider list' },
  { name: '/login', description: 'Sign in or save an API key · /login [PROVIDER]' },
  { name: '/logout', description: 'Remove a saved login · /logout [PROVIDER]' },
  { name: '/goal', description: 'Work until done · /goal [--rounds N] [--budget USD] OBJECTIVE' },
  { name: '/agents', description: 'Switch agents' },
  { name: '/agent', description: 'Switch directly · /agent NAME' },
  { name: '/new', description: 'Create an agent' },
  { name: '/skills', description: 'Browse installed skills' },
  { name: '/skill', description: 'Read skill instructions · /skill NAME' },
  { name: '/use', description: 'Ask the agent to use a skill · /use NAME TASK' },
  { name: '/memory', description: 'Memory status, search, history, sync' },
  { name: '/reflect', description: 'Propose learning; list, apply ID, settings' },
  { name: '/settings', description: 'Browse settings' },
  { name: '/permissions', description: 'Shell, file writes, MCP' },
  { name: '/runtime', description: 'Model, turn limit, compaction, timeout' },
  { name: '/connections', description: 'Connect browsers and MCP servers' },
  { name: '/prompt', description: 'View or edit this agent’s system instructions' },
  { name: '/tools', description: 'Live tools, permissions and connection status' },
  { name: '/cwd', description: 'Choose working directory · /cwd [PATH]' },
  { name: '/theme', description: 'Magic City, purple or plain' },
  { name: '/app', description: 'Theme and startup banner' },
  { name: '/actions', description: 'Recent tool outcomes' },
  { name: '/resume', description: 'Recover unfinished work' },
  { name: '/clear', description: 'Clear screen' },
  { name: '/exit', description: 'Leave harness' },
];
const commands = commandList.map(c => c.name);
const expand = (s: string) => path.resolve(s.replace(/^~(?=\/|$)/, os.homedir()));
const tilde = (p: string) => p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p;
export async function chat(initialHome: string) {
  let home = await fs.realpath(initialHome), app = await readApp();
  let manifest = await readManifest(home), settings = await readSettings(home);
  const connections = new Connections();
  let history: string[] = [], leaving = false;
  // Pickers, the command palette and the spinner need a real terminal on both ends; scripted chat keeps plain prompts.
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const paint = () => makeTheme(app.theme, Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  let theme = paint();
  const accent = (s: unknown) => theme.accent(s), dim = (s: unknown) => theme.dim(s);
  const line = (s = '') => console.log(cleanText(s));
  const panel = (title: string) => console.log('\n' + rule(theme, title, process.stdout.columns || 80));
  // Keep a single iterator in pipe mode so scripted input is never discarded between prompts.
  const piped = !process.stdin.isTTY ? createInterface({ input: process.stdin, terminal: false }) : undefined;
  const iterator = piped?.[Symbol.asyncIterator]();
  const ask = async (label: string, palette = false, extra: { mask?: boolean; signal?: AbortSignal } = {}): Promise<string> => {
    if (iterator) { const next = await iterator.next(); if (next.done) { leaving = true; return ''; } return next.value.trim(); }
    if (tty) {
      if (label.startsWith('\n')) console.log();
      const value = await readLine({ label: label.trimStart(), theme, history: palette ? history : undefined, commands: palette ? commandList : undefined,
        hint: palette ? '/ commands · ↑ history · Esc stops a running turn' : undefined, ...extra });
      if (value === null) { if (palette) leaving = true; return ''; }
      if (palette && value.trim()) history = [value.trim(), ...history.filter(h => h !== value.trim())].slice(0, 200);
      return value.trim();
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, history, completer: text => [commands.filter(c => c.startsWith(text)), text] });
    const abort = new AbortController();
    rl.once('SIGINT', () => { leaving = true; abort.abort(); });
    try { return (await rl.question(accent(label), { signal: abort.signal })).trim(); }
    catch (e) { if (abort.signal.aborted) return ''; throw e; }
    finally { history = [...(rl as unknown as { history: string[] }).history]; rl.close(); }
  };
  const remember = async () => { if (!app.agentHomes.includes(home)) { app.agentHomes.push(home); await saveApp(app); } };
  const save = async () => { await saveSettings(home, settings); await connections.close(); };
  const status = () => console.log(`${theme.strong('◆ ' + manifest.name)}  ${theme.second(manifest.model)}\n${dim('  ' + tilde(settings.cwd || home))}`);
  const banner = async (animate = false) => {
    if (app.banner) { if (animate && tty) await playBanner(theme, process.stdout.columns || 80); else console.log(wordmark(theme, process.stdout.columns || 80)); }
    status();
    console.log(dim(tty ? '  Type / for the command palette  ·  Esc stops a running turn' : '  /help  ·  Tab completes commands  ·  Esc stops a running turn'));
  };
  const showActions = () => {
    panel('Action history');
    const actions = readActions(home).slice(-20);
    if (!actions.length) line('No recorded actions yet.');
    for (const a of actions) console.log(`${a.status === 'completed' ? theme.ok('✓') : theme.warn('?')} ${cleanText(a.status)}  ${cleanText(a.name)}  ${dim(a.time)}\n  ${dim(a.detail || '')}`);
    line('Completed = tool returned a result. Error or unknown can still mean partial changes. Escape does not undo effects.');
  };
  const keyWarning = (provider: string, check: ModelCheck) => theme.warn(`⚠ No credentials for ${provider} in this shell.${check.keyVar ? ` Run /login ${provider} (or export ${check.keyVar} and restart)` : ` Run /login ${provider}`}, or runs on this model will fail.`);
  // Tells the user up front when the agent's saved model cannot run, instead of at the first turn.
  const health = async () => {
    try {
      const check = await checkModel(manifest.model);
      if (!check.exists) console.log(theme.warn(`⚠ ${check.problem}.`) + dim(check.suggestions[0] ? `  Try: /model ${check.suggestions[0]}` : '  Use /model to pick one.'));
      else if (!check.authed) console.log(keyWarning(manifest.model.slice(0, manifest.model.indexOf('/')), check));
    } catch { /* Advisory only. */ }
  };
  const setModel = async (value: string) => {
    const check = await checkModel(value);
    if (!check.exists) throw new Error([check.problem + '.', check.suggestions.length ? 'Did you mean:\n  ' + check.suggestions.join('\n  ') : 'Use /model to browse what is available.'].join('\n'));
    const release = await lockHome(home);
    try { manifest = { ...await readManifest(home), model: value }; await atomicJson(path.join(home, 'agent.json'), manifest); }
    finally { release(); }
    line('Model saved. Pending work must be resumed with its original model.');
    if (!check.authed) console.log(keyWarning(value.slice(0, value.indexOf('/')), check));
  };
  const modelItem = (m: ModelChoice): PickItem<string> => {
    const state = m.state === 'live' ? '● live' : m.state === 'unlisted' ? '◌ new' : '○ catalog';
    return {
      label: m.ref, value: m.ref, current: m.ref === manifest.model, muted: !m.configured,
      badge: (m.configured ? state : `needs ${m.keyVar ?? 'credentials'}`) + (m.free ? ' · free' : ''),
      tone: !m.configured ? 'dim' : m.state === 'live' ? 'ok' : m.state === 'unlisted' ? 'warn' : 'dim',
      detail: [m.name !== m.id ? m.name : '', m.contextWindow ? `${m.contextWindow >= 1e6 ? Number((m.contextWindow / 1e6).toFixed(1)) + 'M' : Math.round(m.contextWindow / 1000) + 'k'} ctx` : '',
        m.costIn !== undefined && m.costOut !== undefined && !m.free ? `$${m.costIn}/$${m.costOut} per M` : ''].filter(Boolean).join(' · '),
      disabled: m.runnable ? undefined : 'The provider offers this model, but this runtime\'s catalog does not know it yet. Update the pi-ai dependency to run it.',
    };
  };
  /** Returns provider/model, or undefined when the user backs out. */
  const chooseModel = async (title = 'Models'): Promise<string | undefined> => {
    if (!tty) return (await ask('Provider/model (Enter returns) > ')) || undefined;
    const manual: PickItem<string> = { label: 'Enter provider/model by hand…', value: '', detail: 'for anything not listed', tone: 'dim' };
    const picked = await pick<string>({ title, theme, items: [manual], status: 'Reading providers…',
      load: api => streamModels((choices, text, done) => { api.set([...choices.map(modelItem), manual]); api.status(text, !done); }, { signal: api.signal }) });
    if (!picked) return undefined;
    return picked.value || (await ask('Provider/model > ')) || undefined;
  };
  const systemPrompt = async (action?: string) => {
    panel('System prompt · ' + manifest.name);
    manifest = await readManifest(home); line(manifest.instructions);
    line('These are your agent’s base instructions in agent.json. Betta also supplies the operating brief, live capabilities, skills, committed memory and any run-specific instructions. Changes apply on the next turn.');
    if (!action && tty) action = (await pick<string>({title:'System prompt',theme,items:[{label:'Keep current instructions',value:'view'},{label:'Paste new instructions',value:'edit'},{label:'Load instructions from a file',value:'file'}]}))?.value;
    else if (!action) action = await ask('view | edit | file (Enter returns) > ');
    if (!action || action === 'view') return;
    let instructions: string;
    if (action === 'file') { const file=await ask('Instructions file path > '); if(!file)return; instructions=await fs.readFile(expand(file),'utf8'); }
    else if (action === 'edit') {
      line('Paste instructions line by line. .save saves; .cancel keeps the current prompt.');
      const lines:string[]=[];
      for(;;) { const text=await ask('> '); if(leaving || text === '.cancel')return; if(text === '.save')break; lines.push(text); }
      instructions=lines.join('\n');
    } else throw new Error('/prompt view | edit | file');
    if(!instructions.trim() || Buffer.byteLength(instructions)>64000)throw new Error('Instructions must contain text and fit within 64 KB');
    const release=await lockHome(home);
    try { const current=await readManifest(home); manifest={...current,instructions}; await atomicJson(path.join(home,'agent.json'),manifest); } finally { release(); }
    line('System instructions saved.');
  };
  const permissions = async () => {
    panel('Permissions · ' + manifest.name);
    line('Shell runs local commands. Files permits write/edit. MCP permits enabled server connections and tools. Network permits HTTP requests.\nMemory tools remain enabled. These are tool access switches, not an operating-system sandbox; shell tools can also modify files.');
    if (tty) {
      const about = { shell: 'run local commands', files: 'write and edit files', mcp: 'connect to enabled MCP servers', network: 'make HTTP requests, including local services', browser:'use Vercel agent-browser', desktop:'use Vercel agent-desktop' };
      for (let at: keyof AgentSettings['permissions'] = 'shell';;) {
        const picked: PickItem<keyof AgentSettings['permissions']> | undefined = await pick<keyof AgentSettings['permissions']>({ title: 'Permissions', theme, filter: false, receipt: false, select: at, hint: '↑↓ move · Enter toggles · Esc done',
          items: (['shell', 'files', 'mcp', 'network', 'browser', 'desktop'] as const).map(k => ({ label: k, value: k, badge: settings.permissions[k] ? '● on' : '○ off', tone: settings.permissions[k] ? 'ok' as const : 'dim' as const, detail: about[k] })) });
        if (!picked) break;
        at = picked.value; settings.permissions[at] = !settings.permissions[at]; await save();
      }
      line(Object.entries(settings.permissions).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join('  ·  ')); return;
    }
    for (const [k,v] of Object.entries(settings.permissions)) line(`${k.padEnd(8)} ${v ? 'on' : 'off'}`);
    const answer = await ask('Change: shell|files|mcp|network|browser|desktop on|off (Enter returns) > ');
    if (!answer) return;
    const [key, value] = answer.split(/\s+/);
    if (!['shell','files','mcp','network','browser','desktop'].includes(key) || !['on','off'].includes(value)) throw new Error('Example: shell on');
    settings.permissions[key as keyof AgentSettings['permissions']] = value === 'on'; await save(); line('Permission saved.');
  };
  const runtime = async () => {
    if (tty) {
      for (let at = 'model';;) {
        const picked = await pick<string>({ title: 'Runtime · ' + manifest.name, theme, filter: false, receipt: false, select: at, hint: '↑↓ move · Enter changes · Esc done', items: [
          { label: 'model', value: 'model', badge: manifest.model, detail: 'pick from the live list' },
          { label: 'maxTurns', value: 'maxTurns', badge: String(settings.maxTurns), detail: '1–1000 tool rounds per request' },
          { label: 'compaction', value: 'compaction', badge: settings.compaction ? '● on' : '○ off', tone: settings.compaction ? 'ok' : 'dim', detail: 'summarise long conversations' },
          { label: 'timeout', value: 'timeout', badge: settings.timeoutSeconds ? settings.timeoutSeconds + 's' : 'unlimited', detail: 'seconds per run; 0 = unlimited' }] });
        if (!picked) return;
        at = picked.value;
        try {
          if (at === 'model') { const model = await chooseModel(); if (model && model !== manifest.model) await setModel(model); continue; }
          if (at === 'compaction') settings.compaction = !settings.compaction;
          else { const value = await ask(at === 'maxTurns' ? 'Max turns > ' : 'Timeout seconds (0 = unlimited) > '); if (!value) continue; if (at === 'maxTurns') settings.maxTurns = Number(value); else settings.timeoutSeconds = Number(value); }
          await save();
        } catch (error) { settings = await readSettings(home); console.log(theme.err(error instanceof Error ? error.message : error)); }
      }
    }
    panel('Runtime · ' + manifest.name);
    line(`model        ${manifest.model}\nmaxTurns     ${settings.maxTurns}\ncompaction   ${settings.compaction ? 'on' : 'off'}\ntimeout      ${settings.timeoutSeconds}s (0 = unlimited)\nRecovery resumes unfinished work on the next run. Escape cancels the current turn.`);
    const answer = await ask('Change: model PROVIDER/ID | maxTurns N | compaction on|off | timeout SECONDS (Enter returns) > ');
    if (!answer) return;
    const [key,value] = answer.split(/\s+/);
    if (key === 'model') { await setModel(value); return; }
    if (key === 'maxTurns') settings.maxTurns = Number(value);
    else if (key === 'timeout') settings.timeoutSeconds = Number(value);
    else if (key === 'compaction' && ['on','off'].includes(value)) settings.compaction = value === 'on';
    else throw new Error('Unknown runtime setting');
    await save(); line('Runtime settings saved.');
  };
  const setTheme = async (name: string) => {
    if (!themeNames.includes(name as ThemeName)) throw new Error('Themes: ' + themeNames.join(', '));
    app.theme = name as ThemeName; await saveApp(app); theme = paint();
  };
  const appearance = async (themesOnly = false) => {
    if (tty) {
      for (let at = 'theme:' + app.theme;;) {
        const picked = await pick<string>({ title: themesOnly ? 'Theme' : 'Application', theme, filter: false, receipt: false, select: at, hint: '↑↓ move · Enter applies · Esc done', items: [
          ...themeNames.map(n => ({ label: n, value: 'theme:' + n, badge: n === app.theme ? '◆ active' : undefined, detail: themeLabels[n] })),
          ...(themesOnly ? [] : [{ label: 'banner', value: 'banner', badge: app.banner ? '● on' : '○ off', tone: app.banner ? 'ok' as const : 'dim' as const, detail: 'startup wordmark' }])] });
        if (!picked) return;
        at = picked.value;
        if (at === 'banner') { app.banner = !app.banner; await saveApp(app); } else await setTheme(at.slice(6));
      }
    }
    panel('Application'); line(`theme    ${app.theme}\nbanner   ${app.banner ? 'on' : 'off'}`);
    const answer = await ask(`Change: theme ${themeNames.join('|')} | banner on|off (Enter returns) > `);
    if (!answer) return;
    const [key,value] = answer.split(/\s+/);
    if (key === 'theme') await setTheme(value);
    else if (key === 'banner' && ['on','off'].includes(value)) { app.banner = value === 'on'; await saveApp(app); }
    else throw new Error('Unknown application setting');
    line('Application settings saved.');
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
    const menu = tty ? await pick<string>({ title: 'Connections', theme, items: [
      {label:'Connect enabled servers',value:'connect'},
      {label:'Connect my Chrome with browse',value:'browser',detail:'requires the browse extension and pairing'},
      {label:'Add a remote MCP URL',value:'remote'},
      {label:'Add a local MCP server',value:'add'},
      {label:'Inspect connected tools',value:'tools'},
      ...settings.connections.flatMap(c => [
        {label:(c.enabled?'Disable ':'Enable ')+c.name,value:(c.enabled?'disable ':'enable ')+c.name,badge:connections.status(c.name)},
        {label:'Remove '+c.name,value:'remove '+c.name}])
    ] }) : undefined;
    const answer = tty ? menu?.value || '' : await ask('browser | remote | add | connect | enable NAME | disable NAME | remove NAME | tools (Enter returns) > ');
    const [action,name] = answer.split(/\s+/);
    if (!answer) return;
    if (action === 'browser' || action === 'remote') {
      const c: Connection = action === 'browser'
        ? { name:'browse',transport:'stdio',command:path.join(os.homedir(),'.local','bin','browse'),args:['mcp'],enabled:true }
        : { name:await ask('Server name > '),transport:'http',url:await ask('MCP server URL > '),bearerEnv:(await ask('Bearer-token environment variable (Enter = none) > ')) || undefined,enabled:true };
      if (settings.connections.some(v => v.name === c.name)) throw new Error('That server already exists; enable it and connect.');
      if(action === 'browser') await fs.access(c.command!);
      const next = { ...settings, permissions:{...settings.permissions,mcp:true}, connections:[...settings.connections,c] };
      await saveSettings(home,next); settings=next; await connections.close();
      await connections.sync(settings, settings.cwd || home, render);
      line(`${c.name}: ${connections.status(c.name)}`);
      if(action === 'browser') line('If Chrome is not paired yet, run ~/.local/bin/browse install --agent none, then pair the browse extension.');
    } else if (action === 'add') {
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
  const activate = async (target: string) => {
    const nextHome = await fs.realpath(target), nextManifest = await readManifest(nextHome), nextSettings = await readSettings(nextHome);
    await connections.close(); home = nextHome; manifest = nextManifest; settings = nextSettings; await remember();
    if (tty) console.log(); status(); await health();
  };
  const newAgent = async () => {
    const name = await ask('Agent name > '); if (!name) return;
    const suggested = path.join(configRoot(), 'agents', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent');
    const destination = tty ? (await ask(`Home path (Enter = ${tilde(suggested)}) > `)) || suggested : await ask('New agent home path > ');
    if (!destination) return;
    const model = tty ? await chooseModel('Model for ' + name) : await ask(`Provider/model (Enter = ${manifest.model}) > `);
    const target = expand(destination);
    try { await fs.access(path.join(target, 'agent.json')); throw new Error('That agent already exists; use /agent'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await initHome(target, name, model || manifest.model); await activate(target);
  };
  const switchAgent = async (arg?: string) => {
    const agents = await listAgents(home, app);
    if (!arg && tty) {
      const picked = await pick<string>({ title: 'Agents', theme, select: home, items: [
        ...agents.map(a => ({ label: a.manifest.name, value: a.home, current: a.home === home, badge: a.home === home ? '◆ current' : undefined, detail: `${a.manifest.model} · ${tilde(a.home)}` })),
        { label: '+ New agent…', value: '', detail: 'create a fresh agent home', tone: 'dim' as const }] });
      if (!picked) return;
      if (!picked.value) return newAgent();
      if (picked.value !== home) await activate(picked.value);
      return;
    }
    if (!arg) { panel('Agents'); agents.forEach((a,i) => line(`${i+1}. ${a.manifest.name}${a.home === home ? ' · current' : ''}\n   ${a.home}`)); }
    const choice = arg || await ask('Agent number, name, or home path (Enter returns) > '); if (!choice) return;
    const matches = agents.filter(a => a.manifest.name.toLowerCase() === choice.toLowerCase());
    if (matches.length > 1) throw new Error('More than one agent has that name; choose a number or path');
    const target = /^\d+$/.test(choice) ? agents[Number(choice)-1]?.home : matches[0]?.home || expand(choice);
    if (!target) throw new Error('Unknown agent');
    await activate(target);
  };
  const showSkill = async (name: string) => { const skill = await readSkill(home, name); panel(skill.title && skill.title !== skill.name ? `${skill.name} · ${skill.title}` : skill.name); line(skill.content); };
  const skillsMenu = async () => {
    const { skills, skipped } = await inspectSkills(home);
    const notes = () => { for (const s of skipped) console.log(theme.warn('  skipped ') + cleanText(s.path) + dim(' — ' + s.reason)); };
    if (tty && skills.length) {
      const picked = await pick<string>({ title: `Skills · ${skills.length}`, theme, hint: '↑↓ move · type to filter · Enter reads · Esc back',
        status: skipped.length ? `${skipped.length} folder${skipped.length > 1 ? 's' : ''} skipped — listed when you close this` : undefined,
        items: skills.map(s => ({ label: s.name, value: s.name, badge: s.source, tone: s.source === 'memory' ? 'second' as const : 'third' as const, detail: s.description })) });
      if (picked) { await showSkill(picked.value); console.log(dim(`\n/use ${picked.value} TASK asks the agent to work with this skill.`)); }
      notes(); return;
    }
    panel('Skills');
    for (const s of skills) line(`${s.name}\n  ${s.description}`);
    if (!skills.length) line(`No skills installed. Add a folder containing SKILL.md under ${path.join(home,'skills')}.`);
    notes();
    line('/skill NAME reads instructions. /use NAME TASK requests a skill explicitly. Loaded skills appear in live activity and /actions.');
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
      if (text) console.log(dim(toolPreview(text)));
    }
    else if (event.type === 'memory_active') console.log(dim(`Memory active: ${event.revision}${event.warning ? ' · '+event.warning : ''}`));
    else if (event.type === 'skill') console.log(theme.second(`◆ Using skill: ${event.name}`));
    else if (event.type === 'recovery') console.log(theme.warn(`Recovering interrupted run ${event.requestId}`));
    else if (event.type === 'connection') console.log(dim(`MCP ${event.name}: ${event.status}${event.message ? ' · ' + event.message : ''}`));
    else if (event.type === 'connection_log') console.log(dim(`[${event.name}] ${event.text}`));
  };
  const run = async (prompt: string, resumeOnly = false, task?: (signal: AbortSignal) => Promise<string>) => {
    const controller = new AbortController(), started = Date.now();
    let doing = '';
    const spin = spinner(theme, () => `Working · ${Math.round((Date.now() - started) / 1000)}s${doing ? ' · ' + doing : ''} · Esc to stop`);
    // The spinner owns the last line between events and stays off while a command streams its own output.
    const live: Emit = event => {
      spin.hide();
      if (event.type === 'command_start') spin.pause();
      if (event.type === 'action' && event.status === 'started') doing = cleanText(event.name);
      render(event);
      if (event.type === 'command_end') spin.resume();
    };
    const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        if (!controller.signal.aborted) { spin.hide(); console.log(theme.warn('\nStopping…')); controller.abort(new Error('Stopped by user')); }
      }
    };
    const sigint = () => controller.abort(new Error('Stopped by user'));
    process.on('SIGINT', sigint);
    const raw = process.stdin.isRaw;
    if (process.stdin.isTTY) { emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.on('keypress', keypress); process.stdin.resume(); }
    try {
      if (tty) spin.start(); else console.log(dim('Working… Esc to stop'));
      if (task) { const text = await task(controller.signal); spin.stop(); panel('Memory reflection'); line(text); return; }
      const result = await runAgent({ home, prompt, requestId: randomUUID(), resumeOnly }, live, undefined, controller.signal, connections);
      spin.stop(); panel(manifest.name); line(result.summary); console.log(dim(`${result.usage.inputTokens} in · ${result.usage.outputTokens} out · $${result.costUsd.toFixed(4)}`));
      return result;
    } catch (error) {
      spin.stop();
      if (controller.signal.aborted) { line('Turn stopped. Use /actions to inspect outcomes; /resume will not restart this cancelled turn.'); }
      else throw error;
    } finally {
      spin.stop();
      process.off('SIGINT', sigint);
      if (process.stdin.isTTY) { process.stdin.off('keypress', keypress); process.stdin.setRawMode(raw || false); process.stdin.pause(); }
    }
  };
  // ── Logins ──
  const login = async (arg: string) => {
    const models = appModels(), stored = new Map(await Promise.all(models.getProviders().map(async p => [p.id, await models.checkAuth(p.id).catch(() => undefined)] as const)));
    let id = arg.trim().toLowerCase();
    if (!id) {
      if (!tty) throw new Error('Usage: /login PROVIDER');
      const first = ['openai', 'opencode', 'opencode-go', 'zai', 'openrouter', 'nvidia', 'anthropic'];
      const list = models.getProviders().filter(p => p.auth.oauth || p.auth.apiKey?.login).sort((a, b) => ((first.indexOf(a.id) + 99) % 99) - ((first.indexOf(b.id) + 99) % 99) || a.id.localeCompare(b.id));
      const picked = await pick<string>({ title: 'Sign in', theme, items: list.map(p => { const state = stored.get(p.id); return { label: p.id, value: p.id, detail: p.name,
        badge: state ? '● ' + (state.source || state.type) : p.auth.oauth && !subscriptionBlocked[p.id] ? 'subscription or key' : 'API key', tone: state ? 'ok' as const : 'dim' as const }; }) });
      if (!picked) return; id = picked.value;
    }
    const provider = models.getProvider(id);
    if (!provider) throw new Error(`Unknown provider "${id}". /login with no name lists them.`);
    const canOauth = Boolean(provider.auth.oauth) && !subscriptionBlocked[id], canKey = Boolean(provider.auth.apiKey?.login);
    if (provider.auth.oauth && subscriptionBlocked[id]) console.log(dim(subscriptionBlocked[id]));
    if (!canOauth && !canKey) throw new Error(`${id} has no interactive login.` + (keyEnvVar(id) ? ` Export ${keyEnvVar(id)} instead.` : ''));
    let type: 'oauth' | 'api_key' = canOauth ? 'oauth' : 'api_key';
    if (canOauth && canKey) {
      if (tty) { const how = await pick<'oauth' | 'api_key'>({ title: provider.name, theme, filter: false, items: [
        { label: provider.auth.oauth!.loginLabel || provider.auth.oauth!.name, value: 'oauth', detail: provider.auth.oauth!.isSubscription ? 'uses your subscription' : '' },
        { label: 'Paste an API key', value: 'api_key', detail: 'billed per token' }] }); if (!how) return; type = how.value; }
      else type = (await ask('1 subscription sign-in · 2 API key > ')) === '2' ? 'api_key' : 'oauth';
    }
    const controller = new AbortController();
    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: async prompt => {
        const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
        if (prompt.type === 'select') {
          if (tty) { const picked = await pick<string>({ title: prompt.message, theme, filter: false, items: prompt.options.map(o => ({ label: o.label, value: o.id, detail: o.description })) }); if (!picked) { controller.abort(new Error('Login cancelled')); throw new Error('Login cancelled'); } return picked.value; }
          line(prompt.options.map((o, n) => `${n + 1} ${o.label}`).join('\n')); return prompt.options[Number(await ask(prompt.message + ' > ')) - 1]?.id ?? prompt.options[0].id;
        }
        const value = await ask(prompt.message + (prompt.type === 'manual_code' ? ' (or just finish in the browser)' : '') + ' > ', false, { mask: prompt.type === 'secret', signal });
        if (!value && !signal.aborted && prompt.type !== 'manual_code') { controller.abort(new Error('Login cancelled')); throw new Error('Login cancelled'); }
        if (!value && prompt.type === 'manual_code') return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        return value;
      },
      notify: event => {
        if (event.type === 'auth_url') {
          console.log(accent('Open this link to sign in:') + '\n' + event.url + (event.instructions ? '\n' + dim(event.instructions) : ''));
          try { spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open', [event.url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {}).unref(); } catch { /* The printed link is enough. */ }
        } else if (event.type === 'device_code') console.log(accent('Go to ') + event.verificationUri + accent(' and enter code ') + theme.strong(event.userCode));
        else console.log(dim(event.message));
      },
    };
    const id0 = await deviceId();
    await models.login(id, type, interaction, { getDeviceId: () => id0, agentName: 'Betta Agents' });
    console.log(theme.ok(`✓ Signed in to ${id}.`) + dim(`  Pick a model with /model ${id}/…  ·  saved in ${tilde(path.join(configRoot(), 'credentials.json'))}`));
  };
  const logout = async (arg: string) => {
    const models = appModels(), saved = await new FileCredentialStore().list();
    if (!saved.length) return line('No saved logins. Keys from environment variables are not stored here.');
    let id = arg.trim().toLowerCase();
    if (!id) {
      if (!tty) throw new Error('Usage: /logout PROVIDER');
      const picked = await pick<string>({ title: 'Remove a saved login', theme, filter: false, items: saved.map(c => ({ label: c.providerId, value: c.providerId, badge: c.type === 'oauth' ? 'subscription' : 'API key' })) });
      if (!picked) return; id = picked.value;
    }
    if (!saved.some(c => c.providerId === id)) throw new Error(`No saved login for ${id}.`);
    await models.logout(id); line(`Removed the saved login for ${id}.`);
  };
  // ── Goal loop ──
  const goal = async (arg: string) => {
    const o = parseGoal(arg);
    let spent = 0, next = '', silent = 0, round = 0, ending = '';
    panel('Goal'); line(o.objective); console.log(dim(`up to ${o.rounds} turns · stops at $${o.budgetUsd.toFixed(2)} · Esc stops the loop`));
    while (!ending) {
      round++;
      console.log(theme.second(`\n◆ Turn ${round}/${o.rounds}`) + dim(`  ·  $${spent.toFixed(4)} spent`));
      const result = await run(goalPrompt(o, round, next));
      if (!result) { ending = 'stopped by you'; break; }
      spent += result.costUsd;
      const status = goalStatus(result.summary);
      if (status.state === 'done') ending = 'done' + (status.note ? ' — ' + status.note : '');
      else if (status.state === 'blocked') ending = 'blocked — ' + (status.note || 'the agent needs something from you');
      else if (status.state === 'none' && ++silent >= 2) ending = 'stopped: the agent gave no status line twice';
      else if (spent >= o.budgetUsd) ending = `stopped at the $${o.budgetUsd.toFixed(2)} budget`;
      else if (round >= o.rounds) ending = `stopped at the ${o.rounds}-turn limit`;
      else { if (status.state !== 'none') silent = 0; next = status.note; }
    }
    panel('Goal ' + (ending.startsWith('done') ? 'complete' : 'ended'));
    console.log((ending.startsWith('done') ? theme.ok('✓ ') : theme.warn('■ ')) + cleanText(ending)); console.log(dim(`${round} turn${round === 1 ? '' : 's'} · $${spent.toFixed(4)}`));
  };
  await remember(); await banner(true); await health();
  try {
    while (!leaving) {
      const prompt = await ask('\nYou › ', true); if (!prompt) continue;
      try {
        settings = await readSettings(home);
        if (!prompt.startsWith('/')) { await run(prompt); continue; }
        const space = prompt.indexOf(' '), cmd = space < 0 ? prompt : prompt.slice(0,space), arg = space < 0 ? '' : prompt.slice(space+1).trim();
        if (cmd === '/exit') break;
        else if (cmd === '/help') { panel('Command palette'); for (const c of commandList) console.log(`${theme.second(c.name.padEnd(14))} ${dim(c.description)}`); }
        else if (cmd === '/model') { const model = arg || await chooseModel(); if (model && model !== manifest.model) await setModel(model); else if (model) { line('Already using ' + model + '.'); await health(); } }
        else if (cmd === '/login') await login(arg);
        else if (cmd === '/logout') await logout(arg);
        else if (cmd === '/goal') await goal(arg);
        else if (cmd === '/theme') { if (arg) { await setTheme(arg); line('Theme: ' + app.theme); } else await appearance(true); }
        else if (cmd === '/memory') {
          panel('Memory');
          let parts = arg.split(/\s+/).filter(Boolean);
          if (!parts.length) { line(JSON.stringify(await memoryCommand(home,'status'),null,2)); line('status · graph [PATH] · browse · core · read PATH · search QUERY · recall QUERY · diff [REV] · history\nrefresh · migrate · commit REASON · revert REV · config [JSON] · bundle PATH · remote URL · push · pull'); parts=(await ask('Memory command (Enter returns) > ')).split(/\s+/).filter(Boolean); }
          if(parts.length) { const result=await memoryCommand(home,parts[0],parts.slice(1)); line(typeof result==='string'?result:JSON.stringify(result,null,2)); }
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
        else if (cmd === '/prompt') await systemPrompt(arg || undefined);
        else if (cmd === '/permissions') await permissions();
        else if (cmd === '/runtime') await runtime();
        else if (cmd === '/app') await appearance();
        else if (cmd === '/cwd') await changeCwd(arg);
        else if (cmd === '/connections') await connectionMenu();
        else if (cmd === '/tools') { await connections.sync(settings, settings.cwd || home, render); line(JSON.stringify(capabilityReport(settings,connections,settings.cwd || home),null,2)); }
        else if (cmd === '/agents' || cmd === '/agent') await switchAgent(arg);
        else if (cmd === '/new') await newAgent();
        else if (cmd === '/skills') await skillsMenu();
        else if (cmd === '/skill') { if (arg) await showSkill(arg); else await skillsMenu(); }
        else if (cmd === '/use') { const i = arg.indexOf(' '); if (i < 1) throw new Error('Usage: /use NAME TASK — /skills lists the names'); const name = arg.slice(0,i); await readSkill(home,name); await run(`Use the installed skill ${JSON.stringify(name)}. First load its instructions with skill_read. Task: ${arg.slice(i+1)}`); }
        else if (cmd === '/actions') showActions();
        else if (cmd === '/resume') await run('',true);
        else if (cmd === '/clear') { if (process.stdout.isTTY) console.clear(); status(); }
        else if (cmd === '/settings') {
          const sections = ['Permissions', 'Runtime', 'Working directory', 'Connections', 'Application', 'Agents', 'Skills', 'Action history', 'Memory', 'Reflection budgets', 'System prompt'];
          let choice: string;
          if (tty) { const picked = await pick<string>({ title: 'Settings', theme, receipt: false, items: sections.map((label, n) => ({ label, value: String(n + 1) })) }); if (!picked) continue; choice = picked.value; }
          else { panel('Settings'); line(sections.map((label, n) => `${String(n + 1).padEnd(2)} ${label}`).join('\n')); choice = await ask('Section (Enter returns) > '); }
          if (choice === '11') await systemPrompt(); else if (choice === '1') await permissions(); else if (choice === '2') await runtime(); else if (choice === '3') await changeCwd(); else if (choice === '4') await connectionMenu(); else if (choice === '5') await appearance(); else if (choice === '6') await switchAgent(); else if (choice === '7') await skillsMenu(); else if (choice === '8') showActions(); else if (choice === '9') { line(JSON.stringify(await memoryCommand(home,'status'),null,2)); line('Use /memory to browse and configure memory.'); } else if (choice === '10') { line(JSON.stringify(await reflectionSettings(home),null,2)); line('Use /reflect settings to adjust budgets.'); }
        } else throw new Error('Unknown slash command. Use /help.');
      } catch (error) { console.log(theme.err(error instanceof Error ? explainRunError(error.message) : error)); }
    }
  } finally { await connections.close(); piped?.close(); }
}
