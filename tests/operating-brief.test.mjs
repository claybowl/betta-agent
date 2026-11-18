import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider,fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { initHome, readManifest } from '../dist/home.js';
import { readSettings, saveSettings } from '../dist/settings.js';
import { readSkill, listSkills } from '../dist/skills.js';
import { runAgent } from '../dist/harness.js';
function fake(responses){const models=createModels(),f=fauxProvider({models:[{id:'test'}]});models.setProvider(f.provider);f.setResponses(responses);return models;}
async function home(t){const h=await fs.mkdtemp(path.join(os.tmpdir(),'betta-skills-'));t.after(()=>fs.rm(h,{recursive:true,force:true}));await initHome(h,'Test','faux/test');return h;}
test('bundled skills are discoverable in fresh homes and the operating brief loads without a model tool call',async t=>{
 const h=await home(t);const names=(await listSkills(h)).map(s=>s.name);for(const n of ['betta-agent','agent-browser','agent-desktop'])assert.ok(names.includes(n));
 assert.equal((await readSkill(h,'agent-desktop')).source,'bundled');
 await runAgent({home:h,prompt:'Hello',requestId:'brief'},undefined,fake([ctx=>{assert.match(JSON.stringify(ctx),/Use skills naturally/);return fauxAssistantMessage('Hello');}]));
});
test('system prompt editing is agent scoped, survives restart, and enters the next model context',async t=>{
 const h=await home(t);const config=h+'-config';t.after(()=>fs.rm(config,{recursive:true,force:true}));
 const child=spawnSync(process.execPath,['dist/cli.js','chat',h],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,DONJON_CONFIG_DIR:config},input:'/prompt edit\nSpeak like a thoughtful lighthouse keeper.\nUse short paragraphs.\n.save\n/exit\n',timeout:10000});
 assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/System instructions saved/);assert.equal((await readManifest(h)).instructions,'Speak like a thoughtful lighthouse keeper.\nUse short paragraphs.');
 await runAgent({home:h,prompt:'Hello',requestId:'prompt'},undefined,fake([ctx=>{assert.match(JSON.stringify(ctx),/lighthouse keeper/);return fauxAssistantMessage('Hello');}]));
 const cancel=spawnSync(process.execPath,['dist/cli.js','chat',h],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,DONJON_CONFIG_DIR:config},input:'/prompt edit\nDiscard this\n.cancel\n/exit\n',timeout:10000});assert.equal(cancel.status,0,cancel.stderr);assert.match((await readManifest(h)).instructions,/lighthouse keeper/);
});
test('browser and desktop tools are absent until separately enabled',async t=>{
 const h=await home(t);const events=[];
 await runAgent({home:h,prompt:'Check desktop',requestId:'no-desktop'},e=>events.push(e),fake([fauxAssistantMessage(fauxToolCall('agent_desktop',{args:['status']}),{stopReason:'toolUse'}),fauxAssistantMessage('Disabled')]));
 assert.equal(events.some(e=>e.type==='action'&&e.name==='agent_desktop'),false);
 const s=await readSettings(h);s.permissions.desktop=true;s.permissions.browser=true;await saveSettings(h,s);
 await runAgent({home:h,prompt:'Inspect tools',requestId:'enabled'},undefined,fake([ctx=>{const text=JSON.stringify(ctx);assert.match(text,/agent_desktop/);assert.match(text,/agent_browser/);return fauxAssistantMessage('Ready');}]));
});
