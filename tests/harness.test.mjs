import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
test('a silent provider reports elapsed time before succeeding without a retry', { timeout: 15_000 }, async t => {
 const dir = await home(t);
 const { promise, resolve } = Promise.withResolvers();
 // Keep the provider silent until the observer sees the wait. The fallback lets the assertion fail if no wait arrives.
 const fallback = setTimeout(resolve, 10_000);
 t.after(() => clearTimeout(fallback));
 const { models, faux } = fake([async () => {
   await promise;
   return fauxAssistantMessage('Delayed answer.');
 }]);
 const events = [];
 const result = await runAgent({ home: dir, prompt: 'Wait', requestId: 'wait' }, event => {
   if (event.type === 'provider_wait' || event.type === 'provider_retry') events.push(event);
   if (event.type === 'provider_wait') resolve();
 }, models);
 assert.equal(result.summary, 'Delayed answer.');
 assert.equal(faux.state.callCount, 1);
 assert.equal(events.length, 1);
 assert.equal(events[0].type, 'provider_wait');
 assert.equal(events[0].model, 'faux/test');
 assert.ok(events[0].elapsedMs >= 5_000);
});

test('an observed durable retry is reported once before the second attempt succeeds', async t => {
 const dir = await home(t);
 const { models, faux } = fake([
   () => { throw new Error('503 temporarily unavailable'); },
   fauxAssistantMessage('Recovered answer.'),
 ]);
 const events = [];
 const result = await runAgent({ home: dir, prompt: 'Retry', requestId: 'retry' }, event => {
   if (event.type === 'provider_retry' || event.type === 'provider_wait') events.push(event);
 }, models);
 assert.equal(result.summary, 'Recovered answer.');
 assert.equal(faux.state.callCount, 2);
 assert.equal(events.length, 1);
 assert.equal(events[0].type, 'provider_retry');
 assert.equal(events[0].model, 'faux/test');
 assert.equal(events[0].attempt, 2);
 assert.ok(events[0].delayMs > 0);
});

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
for (const command of ['resume', 'run']) {
  test(`standalone ${command} reports the interrupted request before provider output`, { timeout: 30_000 }, async t => {
   const dir = await home(t);
   const manifestPath = path.join(dir, 'agent.json');
   const manifest = await readManifest(dir);
   await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, model: 'ollama/test' }));
   const env = { PATH: process.env.PATH, DONJON_CONFIG_DIR: path.join(dir, 'config') };
   const provider = fileURLToPath(new URL('./resume-provider.mjs', import.meta.url));
   const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
   const readRecoveryStatus = (...flags) => {
     const result = spawnSync(process.execPath, ['--import', provider, cli, 'recovery-status', dir, ...flags], {
       env: { ...env, BETTA_TEST_NO_PROVIDER: '1' }, input: '', encoding: 'utf8', timeout: 5_000,
     });
     assert.doesNotMatch(result.stderr, /Unexpected provider call during recovery-status/);
     assert.equal(result.status, 0, result.error?.message ?? result.stderr);
     return result.stdout;
   };
   const checkRecoveryStatus = pendingRequestId => {
     assert.equal(readRecoveryStatus(), JSON.stringify({ pendingRequestId }) + '\n');
   };
   const idleStatus = { pendingRequestId: null, conversationId: null, model: null };
   const checkChatRecoveryStatus = (message, attempts, flag = '') => {
     const result = spawnSync(process.execPath, ['--import', provider, cli, 'chat', dir], {
       env: { ...env, BETTA_TEST_NO_PROVIDER: '1' },
       input: `/recovery-status${flag ? ' ' + flag : ''}\n`.repeat(attempts) + '/exit\n',
       encoding: 'utf8', timeout: 5_000,
     });
     assert.equal(result.status, 0, result.error?.message ?? result.stderr);
     assert.doesNotMatch(result.stdout + result.stderr, /Unexpected provider call during recovery-status/);
     assert.equal(result.stdout.split('\n').filter(line => line.endsWith(message)).length, attempts, result.stdout);
   };
   if (command === 'resume') {
     checkRecoveryStatus(null);
     assert.deepEqual(JSON.parse(readRecoveryStatus('--verbose')), idleStatus);
     await assert.rejects(fs.stat(path.join(dir, 'state', 'runtime.sqlite')), { code: 'ENOENT' });
   }
   const crashed = spawnSync(process.execPath, [fixture, dir, 'crash', 'ollama'], {
     env, encoding: 'utf8', timeout: 10_000,
   });
   assert.equal(crashed.signal, 'SIGKILL', crashed.error?.message ?? crashed.stderr);
   assert.equal((await readMemory(path.join(dir, 'memory'), 'learned.md')).content, 'Remember the blue boat.\n');

   if (command === 'resume') {
     checkChatRecoveryStatus('Interrupted request: crash-proof', 2);
     checkRecoveryStatus('crash-proof');
     checkRecoveryStatus('crash-proof');
     const verbose = readRecoveryStatus('--verbose');
     const { conversationId } = JSON.parse(verbose);
     assert.ok(Number.isSafeInteger(conversationId) && conversationId > 0);
     assert.deepEqual(JSON.parse(verbose), { pendingRequestId: 'crash-proof', conversationId, model: 'ollama/test' });
     checkChatRecoveryStatus(`Interrupted request: crash-proof | Conversation ID: ${conversationId} | Model: ollama/test`, 2, '--verbose');
     assert.equal(readRecoveryStatus('--verbose'), verbose);
   }
   const args = command === 'run' ? ['Remember the blue boat.', 'crash-proof'] : [];
   const child = spawn(process.execPath, ['--import', provider, cli, command, dir, ...args], {
     env, timeout: 10_000, killSignal: 'SIGKILL',
   });
   const notice = 'Recovering interrupted run crash-proof';
   let stdout = '', stderr = '', stdoutAtNotice;
   child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
   child.stderr.setEncoding('utf8').on('data', chunk => {
     stderr += chunk;
     if (stdoutAtNotice === undefined && stderr.split('\n').includes(notice)) {
       stdoutAtNotice = stdout;
       child.stdin.end();
     }
   });
   const [status, signal] = await once(child, 'close');
   assert.equal(stdoutAtNotice, '', `Expected recovery notice before output. stderr: ${stderr}`);
   assert.equal(status, 0, `${command} exited with ${signal ?? status}. stderr: ${stderr}`);
   assert.equal(stderr.split('\n').filter(line => line.includes('Recovering interrupted run')).length, 1);
   assert.equal(stdout, 'Recovered and remembered.\n');
   if (command === 'resume') {
     checkRecoveryStatus(null);
     assert.deepEqual(JSON.parse(readRecoveryStatus('--verbose')), idleStatus);
     checkChatRecoveryStatus('No interrupted work.', 1);
     checkChatRecoveryStatus('No interrupted work.', 1, '--verbose');
   }

   const fresh = spawnSync(process.execPath, ['--import', provider, cli, 'run', dir, 'Fresh prompt'], {
     env, input: '', encoding: 'utf8', timeout: 5_000,
   });
   assert.equal(fresh.status, 0, fresh.error?.message ?? fresh.stderr);
   assert.doesNotMatch(fresh.stderr, /Recovering interrupted run/);
  });
}
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
