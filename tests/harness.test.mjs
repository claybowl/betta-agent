import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { initHome, readMemory, writeMemory, lockHome, exportHome, readManifest } from '../dist/home.js';
import { runAgent } from '../dist/harness.js';
const fixture = fileURLToPath(new URL('./crash-worker.mjs', import.meta.url));
async function home(t) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'donjon-durable-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await initHome(dir,'Test','faux/test');
 return dir;
}
function fake(responses) {
 const models=createModels(), faux=fauxProvider({models:[{id:'test'}]});
 models.setProvider(faux.provider); faux.setResponses(responses);
 return {models,faux};
}
test('memory survives fresh sessions and duplicate requests do not call the model again', async t=>{
 const dir=await home(t);
 await writeMemory(path.join(dir,'memory'),'human.md','Clay prefers concise answers.',''+(await readMemory(path.join(dir,'memory'),'human.md')).sha256);
 const {models,faux}=fake([ctx=>{assert.match(JSON.stringify(ctx),/Clay prefers concise answers/); return fauxAssistantMessage('I remember.');}]);
 const first=await runAgent({home:dir,prompt:'Who am I?',requestId:'one',sessionKey:'a'},undefined,models);
 assert.equal(first.summary,'I remember.');
 const again=await runAgent({home:dir,prompt:'Who am I?',requestId:'one',sessionKey:'a'},undefined,models);
 assert.equal(again.summary,first.summary); assert.equal(faux.state.callCount,1);
 const second=fake([ctx=>{assert.match(JSON.stringify(ctx),/Clay prefers concise answers/); return fauxAssistantMessage('Still remember.');}]);
 assert.equal((await runAgent({home:dir,prompt:'Remember?',requestId:'two',sessionKey:'b'},undefined,second.models)).summary,'Still remember.');
});
test('atomic memory rejects stale writes, traversal, and symlinks; replay is idempotent',async t=>{
 const dir=await home(t), root=path.join(dir,'memory');
 const first=await writeMemory(root,'facts/test.md','one','missing');
 assert.equal((await writeMemory(root,'facts/test.md','one','missing')).sha256,first.sha256);
 await assert.rejects(writeMemory(root,'facts/test.md','two','missing'),/changed/);
 await assert.rejects(readMemory(root,'../agent.md'),/relative/);
 await fs.symlink(os.tmpdir(),path.join(root,'escape'));
 await assert.rejects(readMemory(root,'escape/test.md'),/symlink/);
});
test('a second owner is rejected while first owner holds the lock',async t=>{
 const dir=await home(t), release=await lockHome(dir);
 try { await assert.rejects(lockHome(dir),/busy/); } finally {release();}
 const again=await lockHome(dir); again();
});
test('SIGKILL after a memory effect recovers the same submission without duplicate effects',async t=>{
 const dir=await home(t);
 const crashed=spawnSync(process.execPath,[fixture,dir,'crash'],{encoding:'utf8',timeout:20000});
 assert.equal(crashed.signal,'SIGKILL',crashed.stderr+crashed.stdout);
 assert.equal((await readMemory(path.join(dir,'memory'),'learned.md')).content,'Remember the blue boat.\n');
 const restarted=spawnSync(process.execPath,[fixture,dir,'recover'],{encoding:'utf8',timeout:20000});
 assert.equal(restarted.status,0,restarted.stderr+restarted.stdout);
 const result=JSON.parse(restarted.stdout.trim());
 assert.equal(result.recovered,true); assert.equal(result.summary,'Recovered and remembered.');
 const check=fake([]);
 const again=await runAgent({home:dir,prompt:'Remember the blue boat.',requestId:'crash-proof'},undefined,check.models);
 assert.equal(again.summary,'Recovered and remembered.'); assert.equal(check.faux.state.callCount,0);
});
test('copy export changes identity; continuation snapshot retains sessions',async t=>{
 const dir=await home(t), parent=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-export-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const {models}=fake([fauxAssistantMessage('A stored answer.')]);
 await runAgent({home:dir,prompt:'Hello',requestId:'export-proof'},undefined,models);
 const copy=path.join(parent,'copy'), continuation=path.join(parent,'continuation');
 await exportHome(dir,copy,false); await exportHome(dir,continuation,true);
 assert.notEqual((await readManifest(dir)).id,(await readManifest(copy)).id);
 assert.equal((await readManifest(dir)).id,(await readManifest(continuation)).id);
 assert.equal((await readMemory(path.join(copy,'memory'),'persona.md')).content,(await readMemory(path.join(dir,'memory'),'persona.md')).content);
 await assert.rejects(fs.access(path.join(copy,'state','runtime.sqlite')));
 // Resume the original conversation key (cwd), while using the copied database.
 const fresh=fake([]);
 assert.equal((await runAgent({home:continuation,prompt:'Hello',requestId:'export-proof'},undefined,fresh.models)).summary,'A stored answer.');
 assert.equal(fresh.faux.state.callCount,0);
});

test('explicit cancellation does not leave work queued for the next wake',async t=>{
 const dir=await home(t), controller=new AbortController();
 const first=fake([fauxAssistantMessage('Should be cancelled.')]);
 await assert.rejects(runAgent({home:dir,prompt:'Stop me',requestId:'cancelled'},event=>{
   if(event.type==='init') controller.abort();
 },first.models,controller.signal),/complete|abort/i);
 const next=fake([fauxAssistantMessage('New work only.')]);
 const result=await runAgent({home:dir,prompt:'New work',requestId:'next'},undefined,next.models);
 assert.equal(result.recovered,false); assert.equal(result.summary,'New work only.');
});
test('a crashed agent can be snapshotted and recovered from a relocated home',async t=>{
 const dir=await home(t), parent=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-move-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const crashed=spawnSync(process.execPath,[fixture,dir,'crash'],{encoding:'utf8',timeout:20000});
 assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
 const moved=path.join(parent,'moved'); await exportHome(dir,moved,true);
 const restarted=spawnSync(process.execPath,[fixture,moved,'recover'],{encoding:'utf8',timeout:20000});
 assert.equal(restarted.status,0,restarted.stderr);
 assert.equal(JSON.parse(restarted.stdout).recovered,true);
 assert.equal((await readMemory(path.join(moved,'memory'),'learned.md')).content,'Remember the blue boat.\n');
});
