import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { initHome, exportHome, lockHome } from '../dist/home.js';
import { readSettings, saveSettings, listAgents, validateSettings } from '../dist/settings.js';
import { listSkills } from '../dist/skills.js';
import { Activity, readActions } from '../dist/activity.js';
import { Connections } from '../dist/connections.js';
import { runAgent } from '../dist/harness.js';
import { cleanText } from '../dist/chat.js';
const call = (name,args) => fauxAssistantMessage(fauxToolCall(name,args),{ stopReason:'toolUse' });
function fake(responses) { const models=createModels(), faux=fauxProvider({models:[{id:'test'}]}); models.setProvider(faux.provider); faux.setResponses(responses); return models; }
async function home(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-ui-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); await initHome(dir,'Test','faux/test'); return dir; }
test('settings respect ownership, validate limits and export inactive connections',async t=>{
 const dir=await home(t), s=await readSettings(dir); s.maxTurns=12; s.connections=[{name:'demo',transport:'http',url:'https://example.com/mcp',enabled:true}]; s.permissions.mcp=true; s.cwd=dir;
 const release=await lockHome(dir); await assert.rejects(saveSettings(dir,s),/busy/); release();
 await saveSettings(dir,s); assert.equal((await readSettings(dir)).maxTurns,12);
 assert.throws(()=>validateSettings({...s,maxTurns:0}),/Invalid/);
 const target=dir+'-copy';t.after(()=>fs.rm(target,{recursive:true,force:true}));await exportHome(dir,target,false);
 const copy=await readSettings(target);assert.equal(copy.connections[0].enabled,false);assert.equal(copy.permissions.mcp,false);assert.equal(copy.cwd,undefined);
});
test('shell streams before completion in configured cwd, and a successful receipt is durable',async t=>{
 const dir=await home(t), cwd=path.join(dir,'work');await fs.mkdir(cwd);const s=await readSettings(dir);s.permissions.shell=true;s.cwd=cwd;await saveSettings(dir,s);
 const events=[];
 const models=fake([call('bash',{command:'printf live-output; pwd'}),fauxAssistantMessage('Done')]);
 await runAgent({home:dir,prompt:'Run',requestId:'shell'},e=>events.push(e),models);
 assert.ok(events.find(e=>e.type==='command_output'&&e.text.includes('live-output')));
 assert.equal(events.find(e=>e.type==='command_start').cwd,await fs.realpath(cwd));
 assert.ok(events.findIndex(e=>e.type==='command_output')<events.findIndex(e=>e.type==='command_end'));
 assert.equal(readActions(dir).find(a=>a.name==='bash').status,'completed');
});
test('cancelling a running shell stops follow-on effects and records uncertainty',async t=>{
 const dir=await home(t), s=await readSettings(dir);s.permissions.shell=true;await saveSettings(dir,s);
 const controller=new AbortController();let output=false;
 const models=fake([call('bash',{command:'printf ready; sleep 5; touch SHOULD_NOT_EXIST'}),fauxAssistantMessage('Unexpected')]);
 await assert.rejects(runAgent({home:dir,prompt:'Run',requestId:'stop'},e=>{if(e.type==='command_output'&&e.text.includes('ready')) {output=true;controller.abort();}},models,controller.signal));
 assert.ok(output);await assert.rejects(fs.access(path.join(dir,'SHOULD_NOT_EXIST')));
 assert.equal(readActions(dir).find(a=>a.name==='bash').status,'unknown');
 assert.equal((await runAgent({home:dir,resumeOnly:true},undefined,fake([]))).summary,'No unfinished work.');
});
test('disabled shell is absent and cannot execute even when a model attempts it',async t=>{
 const dir=await home(t);const events=[];
 await runAgent({home:dir,prompt:'Run',requestId:'denied'},e=>events.push(e),fake([call('bash',{command:'touch FORBIDDEN'}),fauxAssistantMessage('Denied')]));
 assert.equal(events.some(e=>e.type==='command_start'),false);await assert.rejects(fs.access(path.join(dir,'FORBIDDEN')));
});
test('skill catalog enters model context and skill_read loads instructions with visible evidence',async t=>{
 const dir=await home(t);await fs.mkdir(path.join(dir,'skills','testing'));await fs.writeFile(path.join(dir,'skills','testing','SKILL.md'),'---\nname: testing\ndescription: Check the widgets\n---\nUse the violet checklist.');
 await fs.symlink(os.tmpdir(),path.join(dir,'skills','escape'));assert.equal((await listSkills(dir)).filter(s=>s.source!=='bundled').length,1);
 const events=[];
 await runAgent({home:dir,prompt:'Check',requestId:'skill'},e=>events.push(e),fake([ctx=>{assert.match(JSON.stringify(ctx),/Check the widgets/);return call('skill_read',{name:'testing'});},ctx=>{assert.match(JSON.stringify(ctx),/violet checklist/);return fauxAssistantMessage('Checked');}]));
 assert.ok(events.some(e=>e.type==='skill'&&e.name==='testing'));assert.equal(readActions(dir).find(a=>a.name==='skill_read').status,'completed');
});
test('MCP connects, calls tools through the agent and disconnects when permission is revoked',async t=>{
 const dir=await home(t),s=await readSettings(dir),pool=new Connections();t.after(()=>pool.close());
 s.permissions.mcp=true;s.connections=[{name:'fixture',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('./mcp-server.mjs',import.meta.url))],enabled:true}];await saveSettings(dir,s);
 await pool.sync(s,dir);assert.equal(pool.status('fixture'),'active');const name=pool.tools()[0].name;
 await runAgent({home:dir,prompt:'Echo',requestId:'mcp'},undefined,fake([call(name,{text:'hello'}),ctx=>{assert.match(JSON.stringify(ctx),/MCP receipt: hello/);return fauxAssistantMessage('Connected');}]),undefined,pool);
 assert.equal(readActions(dir).find(a=>a.name===name).status,'completed');
 s.permissions.mcp=false;await pool.sync(s,dir);assert.equal(pool.tools().length,0);assert.notEqual(pool.status('fixture'),'active');
});
test('incomplete journal entries remain unknown and terminal controls are stripped',async t=>{
 const dir=await home(t);new Activity(dir,()=>{}).record({id:'interrupted',name:'external_write',status:'started'});
 assert.equal(readActions(dir)[0].status,'unknown');assert.equal(cleanText('\x1b[31mred\x1b[0m\x07'),'red');
});
test('slash settings and switching work in scripted chat without model calls',async t=>{
 const dir=await home(t),other=dir+'-alfie',config=dir+'-config';t.after(()=>Promise.all([fs.rm(other,{recursive:true,force:true}),fs.rm(config,{recursive:true,force:true})]));await initHome(other,'Alfie','faux/test');
 const result=spawnSync(process.execPath,['dist/cli.js','chat',dir],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',env:{...process.env,DONJON_CONFIG_DIR:config},input:`/permissions\nshell on\n/cwd ${other}\n/agent ${other}\n/skills\n/exit\n`,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Alfie/);assert.equal((await readSettings(dir)).permissions.shell,true);assert.equal((await readSettings(other)).permissions.shell,false);
 const agents=await listAgents(dir,{agentHomes:[other]});assert.ok(agents.some(a=>a.manifest.name==='Alfie'));
});
test('runtime timeout cancels work instead of queuing it for the next wake',async t=>{
 const dir=await home(t),s=await readSettings(dir);s.permissions.shell=true;s.timeoutSeconds=1;await saveSettings(dir,s);
 await assert.rejects(runAgent({home:dir,prompt:'Wait',requestId:'timeout'},undefined,fake([call('bash',{command:'sleep 5; touch TOO_LATE'}),fauxAssistantMessage('Unexpected')])));
 await assert.rejects(fs.access(path.join(dir,'TOO_LATE')));
 assert.equal((await runAgent({home:dir,resumeOnly:true},undefined,fake([]))).summary,'No unfinished work.');
});

test('chat /settings keeps a deliberate 50-turn limit after restart', async t => {
  const dir = await home(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const defaults = await readSettings(dir);
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    ...defaults, maxTurns: 50, maxTurnsMigrated: undefined, timeoutSeconds: 17,
  }));
  const chat = input => {
    const result = spawnSync(process.execPath, [cli, 'chat', dir], {
      env: { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config'), NO_COLOR: '1' },
      input, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  };
  const edited = chat('/settings\n2\nmaxTurns 50\n/settings\n2\n\n/exit\n');
  assert.deepEqual(Array.from(edited.matchAll(/^maxTurns\s+(\d+)$/gm), match => match[1]), ['150', '50']);
  const restarted = chat('/settings\n2\n\n/exit\n');
  assert.match(restarted, /^maxTurns\s+50$/m);
  assert.match(restarted, /^timeout\s+17s /m);
});

test('chat /compact reduces provider input after restart and preserves recall', async t => {
  const old = 'lantern atlas sentinel';
  const recent = 'The last shipment was cobalt.';
  const core = 'Always use the silver checklist.';
  const provider = fileURLToPath(new URL('./compact-provider.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const counts = [];
  for (const compact of [false, true]) {
    const dir = await home(t);
    const manifestPath = path.join(dir, 'agent.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, model: 'ollama/test' }));
    await fs.writeFile(path.join(dir, 'memory', 'persona.md'), core + '\n');
    const settings = await readSettings(dir);
    await saveSettings(dir, { ...settings, compaction: false });
    const requestsPath = path.join(dir, 'requests.jsonl');
    const chat = (input, cancel = false) => {
      const result = spawnSync(process.execPath, ['--import', provider, cli, 'chat', dir], {
        env: { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config'), COMPACT_REQUESTS: requestsPath, COMPACT_CANCEL: cancel ? '1' : '0', NO_COLOR: '1' },
        input, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
      return result.stdout;
    };
    const setup = chat([
      old + ' ' + 'stock ledger '.repeat(2200),
      'stock ledger '.repeat(5600), recent, '/sessions', '/exit', '',
    ].join('\n'));
    const session = setup.match(/^(.+?)  \d{4}-\d{2}-\d{2}T/m)?.[1];
    assert.ok(session, setup);
    if (compact) {
      if (process.platform !== 'win32') {
        const stopped = chat(`/session ${session}\n/compact\n/exit\n`, true);
        assert.match(stopped, /Compaction stopped\./, stopped);
        assert.doesNotMatch(stopped, /Conversation compacted\./);
      }
      const output = chat(`/session ${session}\n/compact\n/sessions\n/exit\n`);
      assert.match(output, /Conversation compacted\./, output);
      assert.ok(output.split('\n').some(line => line.startsWith(session) && line.endsWith(' · selected')), output);
    }
    chat(`/session ${session}\nCheck current context\nFind the original message\n/exit\n`);
    const requests = (await fs.readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const probe = requests.find(({ messages }) => messages.at(-1).content === 'Check current context');
    assert.ok(probe);
    const messages = JSON.stringify(probe.messages);
    assert.ok(messages.includes(recent));
    assert.ok(messages.includes(core));
    assert.equal(messages.includes(old), !compact);
    // The scripted provider's tokenizer splits the input into word and punctuation tokens.
    counts.push((JSON.stringify({ messages: probe.messages, tools: probe.tools }).match(/\w+|[^\w\s]/g) ?? []).length);
    assert.ok(requests.some(({ messages }) => messages.some(message =>
      message.role === 'tool' && message.content.includes(old + ' stock ledger'))));
  }
  assert.ok(counts[1] < counts[0], `Uncompacted vs. compacted input tokens: ${counts.join(' vs. ')}`);
  t.diagnostic(`Scripted input tokens: ${counts[0]} uncompacted, ${counts[1]} compacted`);
});

test('chat /fork reopens a completed turn with an independent history after restart', async t => {
  const dir = await home(t);
  const manifestPath = path.join(dir, 'agent.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, model: 'ollama/test' }));
  const provider = fileURLToPath(new URL('./compact-provider.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const requestsPath = path.join(dir, 'requests.jsonl');
  const chat = (...commands) => {
    const result = spawnSync(process.execPath, ['--import', provider, cli, 'chat', dir], {
      env: { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config'),
        COMPACT_REQUESTS: requestsPath, FORK_FIXTURE: '1', NO_COLOR: '1' },
      input: [...commands, '/exit', ''].join('\n'), encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  };
  const listed = output => [...output.matchAll(/^([^\s]+:\d+)  \d{4}-\d{2}-\d{2}T/gm)].map(match => match[1]);
  const requests = async () => (await fs.readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const first = 'Amber sentinel', second = 'Indigo sentinel', third = 'Jade sentinel';
  const setup = chat(first, second, third, '/sessions', '/fork 2');
  const [original] = listed(setup);
  const fork = setup.match(/Forked conversation ([^\s]+:\d+)\./)?.[1];
  assert.ok(original && fork && original !== fork, setup);
  assert.equal((await requests()).length, 3, 'Forking and listing should make no provider requests');

  const originalFollowUp = 'Original follow-up sentinel';
  const forkFollowUp = 'Fork follow-up sentinel';
  const defaultFollowUp = 'Default follow-up sentinel';
  const reopened = chat('/sessions', `/session ${original}`, originalFollowUp,
    `/session ${fork}`, '/fork 4', '/sessions', forkFollowUp, '/session default', defaultFollowUp);
  assert.deepEqual(listed(reopened), [original, fork, original, fork], reopened);
  assert.match(reopened, /No completed turn 4 in the selected conversation\./);
  assert.ok(reopened.split('\n').some(line => line.startsWith(fork) && line.endsWith(' · selected')), reopened);

  const turn = prompt => [['user', prompt], ['assistant', `Answer to ${prompt}`]];
  const prefix = [...turn(first), ...turn(second)];
  const history = (await requests()).map(({ messages }) => messages
    .filter(({ role }) => role !== 'system').map(({ role, content }) => [role, content]));
  assert.deepEqual(history.slice(3), [
    [...prefix, ...turn(third), ['user', originalFollowUp]],
    [...prefix, ['user', forkFollowUp]],
    [...prefix, ...turn(third), ...turn(originalFollowUp), ['user', defaultFollowUp]],
  ]);
});
