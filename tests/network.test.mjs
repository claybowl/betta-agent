import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Connections } from '../dist/connections.js';
test('Streamable HTTP MCP authenticates using an env reference and invokes tools',async t=>{
 const pool=new Connections();const servers=new Set();
 process.env.DONJON_TEST_MCP_TOKEN='fixture-secret';
 const httpServer=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401).end();return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  const server=new Server({name:'http-fixture',version:'1.0.0'},{capabilities:{tools:{}}});servers.add(server);
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'hello',inputSchema:{type:'object',properties:{}}}]}));
  server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'HTTP works'}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);await transport.handleRequest(req,res);res.on('close',()=>{void server.close();servers.delete(server);});
 });
 await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{await pool.close();await Promise.all([...servers].map(s=>s.close()));httpServer.closeAllConnections();await new Promise(r=>httpServer.close(r));delete process.env.DONJON_TEST_MCP_TOKEN;});
 const settings={version:1,maxTurns:50,compaction:true,timeoutSeconds:0,permissions:{shell:false,files:false,mcp:true},connections:[{name:'http',transport:'http',url:`http://127.0.0.1:${httpServer.address().port}/mcp`,bearerEnv:'DONJON_TEST_MCP_TOKEN',enabled:true}]};
 await pool.sync(settings,process.cwd());assert.equal(pool.status('http'),'active',pool.errors.get('http'));
 const result=await pool.tools()[0].execute({},null,{});assert.match(result.output[0].text,/HTTP works/);
});
