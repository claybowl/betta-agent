import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpTool, capabilityReport } from '../dist/connectivity.js';
import { readSettings, saveSettings, validateSettings } from '../dist/settings.js';
import { initHome } from '../dist/home.js';
import { runAgent } from '../dist/harness.js';
import { Connections } from '../dist/connections.js';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Activity, readActions } from '../dist/activity.js';
function models(responses) {const m=createModels(), f=fauxProvider({models:[{id:'test'}]});m.setProvider(f.provider);f.setResponses(responses);return m;}
test('HTTP supports auth, bodies, bounded responses, cancellation, and does not follow redirects', async t=>{
 let redirected=0;
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/slow') {setTimeout(()=>res.end('late'),200).unref();return;}
  if(req.url==='/redirect') {res.writeHead(302,{location:'/target'}).end();return;}
  if(req.url==='/target') redirected++;
  let body='';for await(const c of req) body+=c;
  res.end(JSON.stringify({method:req.method,auth:req.headers.authorization,body}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();delete process.env.BETTA_HTTP_TEST;});
 const base=`http://127.0.0.1:${server.address().port}`;
 process.env.BETTA_HTTP_TEST='fixture';
 const result=await httpTool.execute({url:base,method:'POST',bearerEnv:'BETTA_HTTP_TEST',body:'hello'},null,{});
 const data=JSON.parse(result.output[0].text);assert.deepEqual(JSON.parse(data.body),{method:'POST',auth:'Bearer fixture',body:'hello'});
 const small=JSON.parse((await httpTool.execute({url:base,maxBytes:8},null,{})).output[0].text);assert.equal(small.truncated,true);assert.equal(Buffer.byteLength(small.body),8);
 const redirect=JSON.parse((await httpTool.execute({url:base+'/redirect'},null,{})).output[0].text);assert.equal(redirect.status,302);assert.equal(redirected,0);
 const controller=new AbortController();const pending=httpTool.execute({url:base+'/slow'},null,{abortSignal:controller.signal});controller.abort();await assert.rejects(pending);
 await assert.rejects(httpTool.execute({url:'file:///tmp/test'},null,{}),/HTTP/);
});
test('permissions gate HTTP and live capabilities enter model context; request secrets are absent from action arguments',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'betta-connectivity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await initHome(dir,'Test','faux/test');
 const s=await readSettings(dir);assert.equal(Boolean(s.permissions.network),false);
 assert.throws(()=>validateSettings({...s,permissions:{...s.permissions,network:'yes'}}),/Invalid/);
 let events=[];
 await runAgent({home:dir,prompt:'Inspect connectivity',requestId:'disabled'},e=>events.push(e),models([ctx=>{const text=JSON.stringify(ctx);assert.match(text,/mcpClient/);return fauxAssistantMessage(fauxToolCall('http_request',{url:'http://127.0.0.1:1'}),{stopReason:'toolUse'});},fauxAssistantMessage('Denied')]));
 assert.equal(events.some(e=>e.type==='action'&&e.name==='http_request'),false);
 s.permissions.network=true;await saveSettings(dir,s);
 await runAgent({home:dir,prompt:'Inspect connectivity',requestId:'enabled'},undefined,models([fauxAssistantMessage(fauxToolCall('capabilities',{}),{stopReason:'toolUse'}),ctx=>{assert.match(JSON.stringify(ctx),/http_request/);return fauxAssistantMessage('Ready');}]));
 const report=capabilityReport(s,new Connections(),dir);assert.equal(report.http,true);assert.equal(report.mcpClient,true);
 const wrapped=new Activity(dir,()=>{}).wrap({...httpTool,execute:async()=>({output:[]})});
 await wrapped.execute({url:'https://example.com/path?secret=hidden',headers:{Authorization:'hidden'},body:'private'},null,{});
 const entry=readActions(dir).find(a=>a.name==='http_request');assert.doesNotMatch(entry.detail||'',/hidden|private/);
});
