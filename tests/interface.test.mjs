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
