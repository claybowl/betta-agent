import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createModels} from '@earendil-works/pi-ai';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {initHome,lockHome,readMemory,exportHome} from '../dist/home.js';
import {compileMemory,migrateMemory,activateMemory,committedFiles,updateMemory,commitTree,digest,head,git,CONFIG,saveState,searchMemory,recoverMemory} from '../dist/memfs.js';
import {memoryCommand,importMemoryBundle} from '../dist/memory-service.js';
import {recordRecall,recall} from '../dist/recall.js';
import {reflect,proposals,applyReflection,discardReflection} from '../dist/reflection.js';
import {runAgent} from '../dist/harness.js';
import {listSkills,readSkill} from '../dist/skills.js';
function fake(responses){const models=createModels(),faux=fauxProvider({models:[{id:'test'}]});models.setProvider(faux.provider);faux.setResponses(responses);return {models,faux};}
async function home(t, model = 'faux/test'){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-memfs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await initHome(dir,'Test',model);return dir;}
const change=(path,content,old)=>({path,content,expectedHash:old===undefined?'missing':digest(old)});
test('chat /reflect reaches older unconsumed evidence and skips it after apply and restart', async t => {
  const dir = await home(t, 'ollama/test');
  const sourceId = 'older:user';
  const sentinel = 'Prefer amber notebooks.';
  recordRecall(dir, 'older', 'main', 'user', sentinel);
  const consumed = [];
  for (let i = 0; i < 200; i++) {
    const requestId = `reviewed-${i}`;
    recordRecall(dir, requestId, 'main', 'user', 'Previously reviewed evidence.');
    consumed.push(`${requestId}:user`);
  }
  await saveState(dir, 'reflection-consumed.json', consumed);

  const provider = fileURLToPath(new URL('./compact-provider.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const requestsPath = path.join(dir, 'requests.jsonl');
  const response = JSON.stringify({
    summary: 'Notebook preference',
    changes: [{ path: 'notebooks.md', content: sentinel, sourceIds: [sourceId] }],
  });
  const chat = command => {
    const result = spawnSync(process.execPath, ['--import', provider, cli, 'chat', dir], {
      input: `${command}\n/exit\n`, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config'),
        COMPACT_REQUESTS: requestsPath, REFLECTION_FIXTURE_RESPONSE: response, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  };
  const output = chat('/reflect');
  assert.match(output, /"status": "ready"/);
  const [proposal] = await proposals(dir);
  assert.deepEqual(proposal.sourceIds, [sourceId]);
  const requests = await fs.readFile(requestsPath, 'utf8');
  const lines = requests.trim().split('\n');
  assert.equal(lines.length, 1);
  const request = JSON.parse(lines[0]);
  const { evidence } = JSON.parse(request.messages.at(-1).content);
  assert.deepEqual(evidence.map(({ id, text }) => ({ id, text })), [{ id: sourceId, text: sentinel }]);

  assert.match(chat(`/reflect apply ${proposal.id}`), /"status": "applied"/);
  assert.match(chat('/reflect'), /No unconsumed conversation evidence\./);
  assert.equal(await fs.readFile(requestsPath, 'utf8'), requests);
});
test('chat /reflect status counts evidence without changing state or calling the provider', async t => {
  const dir = await home(t, 'ollama/test');
  const expected = [
    { id: 'first:user', text: 'Prefer amber notebooks.' },
    { id: 'second:assistant', text: 'Use a pencil for drafts.' },
  ];
  recordRecall(dir, 'reviewed', 'main', 'user', 'Previously reviewed evidence.');
  recordRecall(dir, 'first', 'main', 'user', expected[0].text);
  recordRecall(dir, 'second', 'main', 'assistant', expected[1].text);
  await saveState(dir, 'reflection-consumed.json', ['reviewed:user']);
  await saveState(dir, 'reflection-proposals.json', []);
  const readState = name => fs.readFile(path.join(dir, 'state', name), 'utf8');
  const consumedBefore = await readState('reflection-consumed.json');
  const proposalsBefore = await readState('reflection-proposals.json');
  const requestsPath = path.join(dir, 'requests.jsonl');
  const provider = fileURLToPath(new URL('./compact-provider.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const chat = input => {
    const result = spawnSync(process.execPath, ['--import', provider, cli, 'chat', dir], {
      input: input + '\n/exit\n', encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config'),
        COMPACT_REQUESTS: requestsPath, REFLECTION_FIXTURE_RESPONSE: '{"summary":"Reviewed","changes":[]}', NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  };

  assert.equal([...chat('/reflect status\n/reflect status').matchAll(/"selectedMessages": 2\b/g)].length, 2);
  assert.match(chat('/reflect status'), /"selectedMessages": 2\b/);
  await assert.rejects(fs.stat(requestsPath), { code: 'ENOENT' });
  assert.equal(await readState('reflection-consumed.json'), consumedBefore);
  assert.equal(await readState('reflection-proposals.json'), proposalsBefore);

  assert.match(chat('/reflect'), /"status": "noop"/);
  const requests = (await fs.readFile(requestsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 1);
  const { evidence } = JSON.parse(requests[0].messages.at(-1).content);
  assert.deepEqual(evidence.map(({ id, text }) => ({ id, text })), expected);

  await saveState(dir, 'reflection-consumed.json', ['reviewed:user', ...expected.map(({ id }) => id)]);
  assert.match(chat('/reflect status'), /No unconsumed conversation evidence/);
  await saveState(dir, 'reflection-settings.json', { maxInputCharacters: 1000 });
  recordRecall(dir, 'oversized', 'main', 'user', 'x'.repeat(1000));
  recordRecall(dir, 'short', 'main', 'user', 'Fits on its own.');
  const blocked = chat('/reflect status');
  assert.match(blocked, /"selectedMessages": 0\b/);
  assert.match(blocked, /"windowMessages": 2\b/);
  assert.match(blocked, /next recall message exceeds the reflection input budget/);
  assert.equal((await fs.readFile(requestsPath, 'utf8')).trim().split('\n').length, 1);
});

test('migration preserves originals in history, adds frontmatter/indexes, and is repeatable',async t=>{
 const dir=await home(t),root=path.join(dir,'memory'),before=await head(root);
 await fs.mkdir(path.join(root,'projects'));await fs.writeFile(path.join(root,'projects','work.md'),'A durable project fact.');
 const s=await migrateMemory(dir);assert.match(s.core,/<human>/);assert.doesNotMatch(s.core,/name: human/);assert.match(s.core,/projects\/MEMORY.md/);assert.doesNotMatch(s.core,/A durable project fact/);
 assert.match(await git(root,['show',`${before}:human.md`]),/# Person/);assert.ok((await committedFiles(root)).has(CONFIG));assert.equal((await migrateMemory(dir)).revision,s.revision);
});
test('one learning updates several files atomically, checks versions and rejects invalid deletion/credentials',async t=>{
 const dir=await home(t),root=path.join(dir,'memory');await migrateMemory(dir);const initial=await head(root),files=await committedFiles(root);
 const result=await updateMemory(dir,[change('projects/example.md','The boat is blue.'),change('human.md',files.get('human.md')+'\nPrefer blue boats.',files.get('human.md'))],'Color preference','transaction-one',['actual-message-id']);
 assert.notEqual(result,initial);assert.ok((await committedFiles(root)).has('projects/MEMORY.md'));
 assert.equal(await updateMemory(dir,[change('projects/example.md','The boat is blue.')],'Color preference','transaction-one',['actual-message-id']),result);
 await assert.rejects(updateMemory(dir,[change('human.md','stale','missing')],'Bad','stale',[]),/changed/);
 await assert.rejects(updateMemory(dir,[change('MEMORY.md',null,(await committedFiles(root)).get('MEMORY.md'))],'Bad','invalid',[]),/root MEMORY/);
 process.env.DONJON_TEST_API_KEY='secret-value-for-test-only';try{await assert.rejects(updateMemory(dir,[change('projects/secret.md',process.env.DONJON_TEST_API_KEY)],'Bad','secret',[]),/credential/);}finally{delete process.env.DONJON_TEST_API_KEY;}
 assert.equal(await head(root),result);assert.match(await git(root,['log','-1','--format=%B']),/actual-message-id/);
});
test('readonly constraints and invalid drafts retain active revision',async t=>{
 const dir=await home(t),root=path.join(dir,'memory');await migrateMemory(dir);const files=await committedFiles(root),config=JSON.parse(files.get(CONFIG));config.readOnlyFiles=['human.md'];files.set(CONFIG,JSON.stringify(config));await commitTree(dir,files,'Protect identity','protect');const good=await activateMemory(dir);
 await assert.rejects(updateMemory(dir,[change('human.md','Changed',(await committedFiles(root)).get('human.md'))],'Bad','protected',[]),/read-only/);
 await fs.writeFile(path.join(root,'MEMORY.md'),'---\nbad draft');const refreshed=await activateMemory(dir);assert.equal(refreshed.revision,good.revision);
 // Even an externally committed invalid tree falls back to the last valid snapshot.
 await git(root,['add','.']);await git(root,['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','External invalid change']);const fallback=await activateMemory(dir);assert.equal(fallback.revision,good.revision);assert.match(fallback.warning,/last valid/);
});
test('runtime holds core fixed within a turn and activates learning on the following turn',async t=>{
 const dir=await home(t);const events=[];let old;
 const first=fake([ctx=>{const str=JSON.stringify(ctx);assert.match(str,/revision/);return fauxAssistantMessage(fauxToolCall('memory_write',{path:'lesson.md',content:'NEW_CORE_LEARNING',expectedHash:'missing'}),{stopReason:'toolUse'});},ctx=>{const system=JSON.stringify(ctx.systemPrompt||ctx.system||[]);assert.doesNotMatch(system,/NEW_CORE_LEARNING/);return fauxAssistantMessage('Learned');}]);
 await runAgent({home:dir,prompt:'Learn this',requestId:'learn'},e=>events.push(e),first.models);
 const active=events.find(e=>e.type==='memory_active');assert.ok(active);assert.notEqual(active.revision,await head(path.join(dir,'memory')));
 await runAgent({home:dir,prompt:'Recall',requestId:'next'},undefined,fake([ctx=>{assert.match(JSON.stringify(ctx),/NEW_CORE_LEARNING/);return fauxAssistantMessage('Remembered');}]).models);
});
test('recall is agent-scoped, idempotent, searchable and redacts known credentials',async t=>{
 const a=await home(t),b=await home(t);process.env.DONJON_TEST_API_KEY='super-secret-sample-value';try{recordRecall(a,'one','main','user','Use '+process.env.DONJON_TEST_API_KEY+' for the boat');recordRecall(a,'one','main','user','duplicate');}finally{delete process.env.DONJON_TEST_API_KEY;}
 assert.equal(recall(a).length,1);assert.match(recall(a,'boat')[0].text,/REDACTED/);assert.equal(recall(b).length,0);
});
test('recall searches past 2000 newer messages and limits literal case-insensitive matches',async t=>{
 const dir=await home(t);
 recordRecall(dir,'older','main','user','A 50% discount.');
 recordRecall(dir,'newer','main','assistant','The DISCOUNT is 75%.');
 recordRecall(dir,'without-percent','main','user','The discount is 75 dollars.');
 recordRecall(dir,'without-discount','main','user','I am 100% certain.');
 for(let i=0;i<2000;i++)recordRecall(dir,`filler-${i}`,'main','user','Unrelated conversation.');
 assert.deepEqual(recall(dir,'DiScOuNt  %').map(entry=>entry.id),['older:user','newer:assistant']);
 assert.deepEqual(recall(dir,'DiScOuNt %',1).map(entry=>entry.id),['newer:assistant']);
});
test('reflection proposes evidence-backed changes and only consumes evidence after application',async t=>{
 const dir=await home(t);await migrateMemory(dir);recordRecall(dir,'source','main','user','My boat is blue.');
 const models=fake([fauxAssistantMessage(JSON.stringify({summary:'Remember the boat color',changes:[{path:'boat.md',content:'The boat is blue.',sourceIds:['source:user']}]}))]);
 const p=await reflect(dir,models.models);assert.equal(p.status,'ready');assert.equal((await committedFiles(path.join(dir,'memory'))).has('boat.md'),false);
 assert.equal((await reflect(dir,models.models)).id,p.id);assert.equal(models.faux.state.callCount,1);
 const applied=await applyReflection(dir,p.id);assert.equal(applied.status,'applied');assert.equal((await committedFiles(path.join(dir,'memory'))).get('boat.md'),'The boat is blue.');assert.equal((await applyReflection(dir,p.id)).status,'applied');
 assert.equal((await reflect(dir,fake([]).models)).status,'noop');
});
test('no-op reflection makes no commit and unsupported provenance is rejected',async t=>{
 const dir=await home(t);await migrateMemory(dir);recordRecall(dir,'a','main','user','Hello');const before=await head(path.join(dir,'memory'));
 const p=await reflect(dir,fake([fauxAssistantMessage('{"summary":"No durable learning","changes":[]}')]).models);assert.equal(p.status,'noop');assert.equal(await head(path.join(dir,'memory')),before);
 recordRecall(dir,'b','main','user','More context');await assert.rejects(reflect(dir,fake([fauxAssistantMessage(JSON.stringify({summary:'Bad',changes:[{path:'bad.md',content:'Fact',sourceIds:['invented']}]}))]).models),/provenance/);
});
test('reflection conflict retains the committed proposal and evidence remains retryable',async t=>{
 const dir=await home(t);await migrateMemory(dir);recordRecall(dir,'a','main','user','Prefer violet');const root=path.join(dir,'memory');const old=(await committedFiles(root)).get('human.md');
 const p=await reflect(dir,fake([fauxAssistantMessage(JSON.stringify({summary:'Violet preference',changes:[{path:'human.md',content:old+'\nPrefer violet.',sourceIds:['a:user']}]}))]).models);
 await updateMemory(dir,[change('human.md',old+'\nPrefer green.',old)],'Green correction','green',['a:user']);const result=await applyReflection(dir,p.id);assert.equal(result.status,'conflict');assert.ok(await git(root,['rev-parse',p.branch]));assert.equal((await proposals(dir)).find(x=>x.id===p.id).status,'conflict');
 await discardReflection(dir,p.id);assert.equal((await proposals(dir)).find(x=>x.id===p.id).status,'failed');
});
test('history bundle export/import preserves Git knowledge and continuation copies recall',async t=>{
 const dir=await home(t);await runAgent({home:dir,prompt:'Hello',requestId:'hi'},undefined,fake([fauxAssistantMessage('Hello again')]).models);const bundle=path.join(dir,'memory.bundle');await memoryCommand(dir,'bundle',[bundle]);
 const target=dir+'-import',continued=dir+'-continue';t.after(()=>Promise.all([fs.rm(target,{recursive:true,force:true}),fs.rm(continued,{recursive:true,force:true})]));
 await importMemoryBundle(bundle,target,'Copy','faux/test');assert.equal(await head(path.join(target,'memory')),await head(path.join(dir,'memory')));
 await exportHome(dir,continued,true,true);assert.equal(await head(path.join(continued,'memory')),await head(path.join(dir,'memory')));assert.equal(recall(continued).length,2);
});
test('memory controls search and revert through a new commit rather than rewinding history',async t=>{
 const dir=await home(t);await migrateMemory(dir);const root=path.join(dir,'memory'),before=await head(root);await updateMemory(dir,[change('projects/boats.md','Blue boats sail in the lake.')],'Boats','boats',['message']);
 assert.equal((await searchMemory(root,'boats lake'))[0].path,'projects/boats.md');await memoryCommand(dir,'revert',[before]);assert.notEqual(await head(root),before);assert.equal((await committedFiles(root)).has('projects/boats.md'),false);
});
test('SIGKILL between intent and HEAD update recovers a complete multi-file learning exactly once',async t=>{
 const dir=await home(t);await migrateMemory(dir);const root=path.join(dir,'memory'),before=await head(root);
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./memory-crash-worker.mjs',import.meta.url)),dir],{encoding:'utf8',timeout:15000});assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(await head(root),before);
 await recoverMemory(dir);const files=await committedFiles(root);assert.equal(files.get('projects/crash.md'),'Applied once after recovery.');assert.ok(files.has('projects/MEMORY.md'));
 const after=await head(root);await recoverMemory(dir);assert.equal(await head(root),after);assert.equal(await updateMemory(dir,[change('projects/crash.md','Applied once after recovery.')],'Replay','crash-multi-file',['message-source']),after);
});
test('MemFS skills take precedence and uncommitted skill edits do not enter agent context',async t=>{
 const dir=await home(t);await migrateMemory(dir);await fs.mkdir(path.join(dir,'skills','review'));await fs.writeFile(path.join(dir,'skills','review','SKILL.md'),'description: Legacy skill\nLegacy instructions.');
 await updateMemory(dir,[change('skills/review/SKILL.md','---\nname: review\ndescription: Memory skill\n---\nCommitted instructions.')],'Add skill','skill',['source']);
 assert.equal((await listSkills(dir)).filter(s=>s.name==='review').length,1);assert.match((await readSkill(dir,'review')).content,/Committed instructions/);
 await fs.writeFile(path.join(dir,'memory','skills','review','SKILL.md'),'Uncommitted injection');assert.doesNotMatch((await readSkill(dir,'review')).content,/Uncommitted injection/);
});
test('local remote synchronization preserves ancestry and refuses divergent imports',async t=>{
 const a=await home(t),b=await home(t);await migrateMemory(a);const rootA=path.join(a,'memory');const remote=path.join(a,'remote.git');await git(a,['init','--bare',remote]);await memoryCommand(a,'remote',[remote]);await memoryCommand(a,'push');
 const bundle=path.join(a,'share.bundle');await memoryCommand(a,'bundle',[bundle]);const imported=b+'-remote';t.after(()=>fs.rm(imported,{recursive:true,force:true}));await importMemoryBundle(bundle,imported,'Peer','faux/test');await memoryCommand(imported,'remote',[remote]);
 await updateMemory(a,[change('shared.md','Shared learning.')],'Share','share',['message']);await memoryCommand(a,'push');await memoryCommand(imported,'pull');assert.equal((await committedFiles(path.join(imported,'memory'))).get('shared.md'),'Shared learning.');await memoryCommand(imported,'push');
 // Peer history is now ahead; a has not fetched it and must not force overwrite it.
 await updateMemory(a,[change('other.md','Independent')],'Diverge','diverge',['message']);await assert.rejects(memoryCommand(a,'pull'));
});
test('reflection budgets reject expensive requests before calling the model',async t=>{
 const dir=await home(t);await migrateMemory(dir);recordRecall(dir,'a','main','user','Remember blue boats');await saveState(dir,'reflection-settings.json',{maxCostUsd:0});
 // faux model has a positive catalog cost, but even if its default cost is zero, timeout/input constraints are validated separately.
 const models=fake([fauxAssistantMessage('{"summary":"Nothing","changes":[]}')]);const model=models.models.getModel('faux','test');
 if(model.cost.input>0||model.cost.output>0){await assert.rejects(reflect(dir,models.models),/budget/);assert.equal(models.faux.state.callCount,0);}
 else {await saveState(dir,'reflection-settings.json',{maxInputCharacters:1});await assert.rejects(reflect(dir,models.models),/budget/);assert.equal(models.faux.state.callCount,0);}
});
test('manual Pi compaction keeps committed core memory available on the following run',async t=>{
 const dir=await home(t);await migrateMemory(dir);const root=path.join(dir,'memory');await updateMemory(dir,[change('identity.md','The durable lighthouse is violet.')],'Identity','identity',['source']);
 const first=fake([fauxAssistantMessage('Long answer. '.repeat(1000))]);const initial=await runAgent({home:dir,prompt:'Discuss history. '.repeat(1000),requestId:'before-compact'},undefined,first.models);
 const {Harness,createRegistry}=await import('@earendil-works/pi-durable');const {openNodeSqliteStorage}=await import('@earendil-works/pi-durable/storage/sqlite/node');const {BACKGROUND_CONTEXT:context}=await import('@earendil-works/chord/context');
 const compactModels=fake([fauxAssistantMessage('A compacted conversation summary.')]);const runtime=await Harness.open(await openNodeSqliteStorage(path.join(dir,'state','runtime.sqlite')),{models:compactModels.models,registry:createRegistry(),settings:{compaction:{enabled:true,keepRecentTokens:10}}},context);
 try{const c=await runtime.conversation(initial.sessionId,context);const task=await c.compact(undefined,context);await runtime.waitForTask(task,context);assert.ok(compactModels.faux.state.callCount>0);}finally{await runtime.close(context);}
 await runAgent({home:dir,prompt:'What color is the lighthouse?',requestId:'after-compact'},undefined,fake([ctx=>{assert.match(JSON.stringify(ctx),/durable lighthouse is violet/);return fauxAssistantMessage('Violet.');}]).models);
});
test('small model memory budget rejects oversized context before any generation',async t=>{
 const dir=await home(t);await migrateMemory(dir);await updateMemory(dir,[change('long.md','Memory '.repeat(500))],'Long memory','long',['source']);const models=createModels();const faux=fauxProvider({models:[{id:'tiny',contextWindow:1000}]});models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage('Should not run')]);
 await assert.rejects(runAgent({home:dir,model:'faux/tiny',prompt:'Hello',requestId:'tiny'},undefined,models),/budget/);assert.equal(faux.state.callCount,0);
});
test('failed reflection does not spend again without explicit retry and preview shows the proposed diff',async t=>{
 const dir=await home(t);await migrateMemory(dir);recordRecall(dir,'a','main','user','Durable fact');await assert.rejects(reflect(dir,fake([fauxAssistantMessage('invalid JSON')]).models));const next=fake([]);assert.equal((await reflect(dir,next.models)).status,'failed');assert.equal(next.faux.state.callCount,0);
 const {previewReflection}=await import('../dist/reflection.js');const p=(await proposals(dir))[0];await saveState(dir,'reflection-proposals.json',[{...p,status:'failed',error:'Retry requested'}]);const result=await reflect(dir,fake([fauxAssistantMessage(JSON.stringify({summary:'Fact',changes:[{path:'fact.md',content:'Durable fact.',sourceIds:['a:user']}]}))]).models);assert.match((await previewReflection(dir,result.id)).diff,/\+Durable fact/);
 await applyReflection(dir,result.id);const integrated=await head(path.join(dir,'memory'));await saveState(dir,'reflection-proposals.json',[{...result,status:'ready'}]);await saveState(dir,'reflection-consumed.json',[]);await applyReflection(dir,result.id);assert.equal(await head(path.join(dir,'memory')),integrated);
});
test('chat memory controls and reflection preview are reachable without a model call',async t=>{
 const dir=await home(t);const config=dir+'-config';t.after(()=>fs.rm(config,{recursive:true,force:true}));const out=spawnSync(process.execPath,['dist/cli.js','chat',dir],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:'/memory migrate\n/memory status\n/memory browse\n/reflect\n/reflect list\n/exit\n',encoding:'utf8',timeout:15000,env:{...process.env,DONJON_CONFIG_DIR:config}});assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/revision/);assert.match(out.stdout,/No unconsumed conversation evidence/);
});
test('nested legacy system memory remains core rather than becoming deferred knowledge',async t=>{
 const dir=await home(t),root=path.join(dir,'memory');await fs.mkdir(path.join(root,'system','preferences'),{recursive:true});await fs.writeFile(path.join(root,'system','preferences','style.md'),'Always use the violet lighthouse example.');const snapshot=await migrateMemory(dir);assert.match(snapshot.core,/<preferences_style>/);assert.match(snapshot.core,/violet lighthouse example/);assert.equal(snapshot.paths.some(p=>p.startsWith('system/')),false);
});
test('legacy system-layout bundles import without scaffolding collisions',async t=>{
 const dir=await home(t),root=path.join(dir,'memory');await fs.rm(path.join(root,'MEMORY.md'));await fs.rm(path.join(root,'human.md'));await fs.rm(path.join(root,'persona.md'));await fs.mkdir(path.join(root,'system'));await fs.writeFile(path.join(root,'system','persona.md'),'I remember the old lighthouse.');await git(root,['add','.']);await git(root,['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','Legacy layout']);const bundle=path.join(dir,'legacy.bundle');await git(root,['bundle','create',bundle,'--all']);const imported=dir+'-legacy';t.after(()=>fs.rm(imported,{recursive:true,force:true}));await importMemoryBundle(bundle,imported,'Legacy','faux/test');assert.match((await compileMemory(path.join(imported,'memory'))).core,/old lighthouse/);
});
