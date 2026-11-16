import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initHome } from '../dist/home.js';
import { inspectSkills, frontmatter } from '../dist/skills.js';
import { filterItems, matchCommands, makeTheme, banner, clip } from '../dist/tui.js';
import { parseGoal, goalStatus, goalPrompt } from '../dist/goal.js';
import { FileCredentialStore, appModels, subscriptionBlocked } from '../dist/credentials.js';
import { streamModels, liveEndpoint, parseModelList, checkModel, suggestModels, explainRunError, keyEnvVar } from '../dist/model-list.js';
import { readApp } from '../dist/settings.js';
test('skill frontmatter: folded descriptions, lowercase file names, and skipped folders are reported',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-skill-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await initHome(dir,'Test','faux/test');
 const put=async(name,file,text)=>{await fs.mkdir(path.join(dir,'skills',name),{recursive:true});await fs.writeFile(path.join(dir,'skills',name,file),text);};
 await put('folded','SKILL.md','---\nname: Folded Skill\ndescription: >\n  Check the widgets\n  twice over.\nlicense: MIT\n---\n# Body\n');
 await put('lower','skill.md','---\nname: lower\n---\n# Heading\nFirst body line.\n');
 await put('quoted','SKILL.md','---\ndescription: "Quoted: with colon"\n---\n');
 await put('empty','README.md','not a skill');
 await fs.symlink(os.tmpdir(),path.join(dir,'skills','linked'));
 const {skills,skipped}=await inspectSkills(dir),by=Object.fromEntries(skills.map(s=>[s.name,s]));
 assert.equal(by.folded.description,'Check the widgets twice over.');assert.equal(by.folded.title,'Folded Skill');
 assert.equal(by.lower.description,'First body line.');assert.equal(by.quoted.description,'Quoted: with colon');
 assert.deepEqual(skills.map(s=>s.name),['folded','lower','quoted']);
 assert.match(skipped.find(s=>s.path==='linked').reason,/symbolic link/);assert.match(skipped.find(s=>s.path==='empty').reason,/no SKILL.md/);
 assert.deepEqual(frontmatter('no frontmatter\ndescription: x'),{});
});
test('command palette and picker filtering rank prefix matches first',()=>{
 const commands=[{name:'/memory',description:'Memory status'},{name:'/model',description:'Choose a model'},{name:'/agents',description:'Switch agents'},{name:'/theme',description:'Magic City'}];
 assert.deepEqual(matchCommands(commands,'/m').map(c=>c.name),['/memory','/model']);
 assert.deepEqual(matchCommands(commands,'/gent').map(c=>c.name),['/agents']);
 assert.deepEqual(matchCommands(commands,'/magic').map(c=>c.name),['/theme']);
 assert.deepEqual(matchCommands(commands,'/model x'),[]);assert.deepEqual(matchCommands(commands,'hello'),[]);
 const items=[{label:'openai/gpt-sonnet-like',value:1},{label:'anthropic/claude-sonnet-5',value:2,detail:'1M ctx'},{label:'sonnet-local',value:3}];
 assert.deepEqual(filterItems(items,'sonnet').map(i=>i.value),[3,1,2]);
 assert.deepEqual(filterItems(items,'anth 1m').map(i=>i.value),[2]);assert.equal(filterItems(items,'').length,3);
});
test('themes stay plain without color, strip control characters, and the banner fits narrow terminals',()=>{
 const plain=makeTheme('magic',false);assert.equal(plain.accent("\x1b[31mred\x1b[0m\x07"),'red');
 assert.match(makeTheme('magic',true).accent('x'),/^\x1b\[38;/);assert.equal(makeTheme('plain',true).accent('x'),'x');
 assert.match(banner(plain,60),/A G E N T S/);assert.ok(banner(plain,80).split('\n').every(l=>[...l].length<=80));assert.match(banner(plain,80),/█▀|▀█/);assert.match(banner(plain,80),/Small fish\. Long memory\./);assert.ok(banner(plain,30).split('\n').every(l=>[...l].length<=30));
 assert.equal(clip('abcdef',4),'abc…');
});
test('model list marks live models, keeps unknown live models non-runnable, and survives a failing provider',async()=>{
 const model=(provider,id,api,baseUrl)=>({provider,id,name:id.toUpperCase(),api,baseUrl,contextWindow:200000,cost:{input:1,output:2}});
 const models={getAvailable:async()=>[model('anthropic','claude-a','anthropic-messages','https://api.anthropic.com'),model('anthropic','claude-old','anthropic-messages','https://api.anthropic.com'),model('groq','llama','openai-completions','https://api.groq.com/openai/v1'),model('azure','gpt','openai-responses','https://example.azure.com')],
  getAuth:async provider=>({auth:{apiKey:'key-'+provider}})};
 const seen=[],updates=[];
 const fetchFake=async(url,init)=>{seen.push([String(url),init.headers]);
  if(String(url).startsWith('https://api.anthropic.com'))return new Response(JSON.stringify({data:[{id:'claude-a',display_name:'Claude A'},{id:'claude-new',display_name:'Claude New'},{id:'claude-embed-1'}]}));
  if(String(url).includes('groq'))return new Response('no',{status:401});
  if(String(url).startsWith('http://ollama.test'))return new Response(JSON.stringify({data:[{id:'qwen:9b'}]}));
  throw new Error('unexpected '+url);};
 const result=await streamModels((choices,status,done)=>updates.push({n:choices.length,status,done}),{models,fetch:fetchFake,env:{OLLAMA_BASE_URL:'http://ollama.test/v1'}});
 const by=Object.fromEntries(result.map(c=>[c.ref,c]));
 assert.equal(by['anthropic/claude-a'].state,'live');assert.equal(by['anthropic/claude-old'].state,'catalog');
 assert.equal(by['anthropic/claude-new'].state,'unlisted');assert.equal(by['anthropic/claude-new'].runnable,false);assert.equal(by['anthropic/claude-embed-1'],undefined);
 assert.equal(by['ollama/qwen:9b'].runnable,true);assert.equal(by['groq/llama'].state,'catalog');assert.equal(by['azure/gpt'].runnable,true);
 assert.equal(updates[0].done,false);assert.equal(updates.at(-1).done,true);assert.match(updates.at(-1).status,/anthropic ✓/);assert.match(updates.at(-1).status,/groq ✗ HTTP 401/);
 // A key only travels to its own provider's catalog URL; unverified providers get no live request.
 assert.equal(seen.find(([u])=>u.includes('anthropic'))[1]['x-api-key'],'key-anthropic');assert.equal(seen.some(([u])=>u.includes('azure')),false);
 assert.equal(liveEndpoint('openai','openai-responses','http://insecure.example/v1','k'),undefined);
 assert.deepEqual(parseModelList({models:[{name:'models/gemini-x',displayName:'Gemini X',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}]}),[{id:'gemini-x',name:'Gemini X'}]);
});
test('saved settings from before the new look move to Magic City once; an explicit choice afterwards is kept',async t=>{
 const config=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-app-'));t.after(()=>fs.rm(config,{recursive:true,force:true}));
 const prior=process.env.DONJON_CONFIG_DIR;process.env.DONJON_CONFIG_DIR=config;t.after(()=>{if(prior===undefined)delete process.env.DONJON_CONFIG_DIR;else process.env.DONJON_CONFIG_DIR=prior;});
 assert.equal((await readApp()).theme,'magic');
 await fs.writeFile(path.join(config,'settings.json'),JSON.stringify({version:1,theme:'purple',banner:true,agentHomes:[]}));assert.equal((await readApp()).theme,'magic');
 await fs.writeFile(path.join(config,'settings.json'),JSON.stringify({version:1,theme:'purple',banner:true,agentHomes:[],look:2}));assert.equal((await readApp()).theme,'purple');
});

const entry=(provider,id,cost={input:1,output:2})=>({provider,id,name:id,api:'openai-completions',baseUrl:'https://x.test/v1',contextWindow:128000,cost});
const catalog=[entry('nvidia','nvidia/nemotron-3.5-lightning-30b-a3b'),entry('nvidia','meta/llama-3.3-70b-instruct'),entry('opencode','nemotron-3.5-lightning-free',{input:0,output:0}),entry('anthropic','claude-a'),entry('zai','glm-4.7')];
const fakeModels=(keyed=[])=>({getModels:()=>catalog,getAvailable:async()=>catalog.filter(m=>keyed.includes(m.provider)),getAuth:async()=>undefined,
 getProvider:name=>catalog.some(m=>m.provider===name)?{}:undefined,getModel:(p,id)=>catalog.find(m=>m.provider===p&&m.id===id),checkAuth:async p=>keyed.includes(p)?{}:undefined});
test('model list shows providers without keys, marked with the variable they need, after configured ones',async()=>{
 const result=await streamModels(()=>{},{models:fakeModels(['anthropic']),fetch:async()=>{throw new Error('offline');},env:{}});
 assert.equal(result[0].ref,'anthropic/claude-a');assert.equal(result[0].configured,true);
 const nv=result.find(c=>c.ref==='nvidia/nvidia/nemotron-3.5-lightning-30b-a3b');
 assert.equal(nv.configured,false);assert.equal(nv.runnable,true);assert.equal(nv.keyVar,'NVIDIA_API_KEY');
 assert.equal(result.find(c=>c.ref==='opencode/nemotron-3.5-lightning-free').free,true);
 // Keyless favorites lead the rest, and free models lead within a provider.
 const keyless=result.filter(c=>!c.configured).map(c=>c.provider);assert.deepEqual([...new Set(keyless)],['opencode','zai','nvidia']);
 let status='';await streamModels((c,text)=>{status=text;},{models:fakeModels([]),fetch:async()=>{throw new Error('offline');},env:{}});
 assert.match(status,/No provider keys are set/);
});
test('typed model refs are checked: the namespaced NVIDIA id passes, the dropped prefix is corrected, missing keys are reported',async()=>{
 const models=fakeModels([]);
 const good=await checkModel('nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',models);
 assert.equal(good.exists,true);assert.equal(good.authed,false);assert.equal(good.keyVar,'NVIDIA_API_KEY');
 const dropped=await checkModel('nvidia/nemotron-3.5-lightning-30b-a3b',models);
 assert.equal(dropped.exists,false);assert.equal(dropped.suggestions[0],'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b');
 const typo=await checkModel('nvidiaa/x',models);assert.equal(typo.exists,false);assert.match(typo.problem,/Unknown provider/);assert.deepEqual(typo.suggestions,['nvidia']);
 assert.equal((await checkModel('nvidia',models)).exists,false);assert.equal((await checkModel('nvidia/',models)).exists,false);
 assert.equal((await checkModel('ollama/anything:7b',models)).exists,true);
 assert.equal((await checkModel('opencode/nemotron-3.5-lightning-free',fakeModels(['opencode']))).authed,true);
 assert.deepEqual(suggestModels('zai/nope-model-zzz',models),[]);
});
test('a provider-not-configured failure names the variable to export',()=>{
 assert.match(explainRunError('Provider is not configured: nvidia'),/\/login nvidia, or export NVIDIA_API_KEY/);
 assert.equal(explainRunError('something else'),'something else');
 assert.equal(keyEnvVar('opencode-go'),'OPENCODE_API_KEY');assert.equal(keyEnvVar('zai'),'ZAI_API_KEY');
});

test('goal loop: arguments, status line parsing and prompts',()=>{
 assert.deepEqual(parseGoal('--rounds 3 --budget 0.5 ship the docs'),{objective:'ship the docs',rounds:3,budgetUsd:0.5});
 assert.deepEqual(parseGoal('fix tests'),{objective:'fix tests',rounds:8,budgetUsd:2});
 assert.throws(()=>parseGoal('--rounds 0 x'));assert.throws(()=>parseGoal('--budget nope x'));assert.throws(()=>parseGoal('  '));
 assert.deepEqual(goalStatus('did things\n**GOAL_STATUS: DONE — tests pass**'),{state:'done',note:'tests pass'});
 assert.equal(goalStatus('GOAL_STATUS: CONTINUE - write the parser\nmore text').note,'write the parser');
 assert.equal(goalStatus('GOAL_STATUS: blocked: need a key').state,'blocked');assert.equal(goalStatus('all good').state,'none');
 assert.match(goalPrompt(parseGoal('x'),1),/GOAL_STATUS: DONE/);assert.match(goalPrompt(parseGoal('x'),2,'step two'),/turn 2 of 8[\s\S]*step two/);
});
test('saved logins: owner-only file, a stored key makes its provider usable, logout removes it',async t=>{
 const config=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-cred-'));t.after(()=>fs.rm(config,{recursive:true,force:true}));
 const prior=process.env.DONJON_CONFIG_DIR,key=process.env.NVIDIA_API_KEY;process.env.DONJON_CONFIG_DIR=config;delete process.env.NVIDIA_API_KEY;
 t.after(()=>{if(prior===undefined)delete process.env.DONJON_CONFIG_DIR;else process.env.DONJON_CONFIG_DIR=prior;if(key!==undefined)process.env.NVIDIA_API_KEY=key;});
 const models=appModels();assert.equal(await models.checkAuth('nvidia'),undefined);
 await models.login('nvidia','api_key',{prompt:async()=>'nv-test-key',notify(){}});
 assert.equal((await fs.stat(path.join(config,'credentials.json'))).mode&0o777,0o600);
 assert.equal((await appModels().getAuth('nvidia')).auth.apiKey,'nv-test-key');
 assert.deepEqual(await new FileCredentialStore().list(),[{providerId:'nvidia',type:'api_key'}]);
 assert.equal((await checkModel('nvidia/nvidia/nemotron-3.5-lightning-30b-a3b')).authed,true);
 await appModels().logout('nvidia');assert.equal(await appModels().checkAuth('nvidia'),undefined);
 assert.ok(subscriptionBlocked.anthropic);
});
