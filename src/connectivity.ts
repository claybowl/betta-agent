import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { AgentSettings } from './settings.js';
import type { Connections } from './connections.js';

export function capabilityReport(settings: AgentSettings, pool: Connections, cwd: string) {
  return { host: 'Betta Agents', mcpClient: true, cwd, permissions: settings.permissions,
    http: Boolean(settings.permissions.network),
    automation: { preferredBrowser:'agent-browser', preferredDesktop:'agent-desktop', browserEnabled:Boolean(settings.permissions.browser), desktopEnabled:Boolean(settings.permissions.desktop), note:'Enabled means the tool may execute; installed binary, browser connectivity and OS permissions must still be checked.' },
    servers: settings.connections.map(c => ({ name: c.name, transport: c.transport, enabled: c.enabled, status: pool.status(c.name), error: pool.errors.get(c.name) })),
    mcpTools: pool.tools().map(t => ({ name: t.name, description: t.description })),
    controls: '/permissions changes tool access; /connections manages MCP servers; /tools shows current capabilities. A configured server is not necessarily connected. agent_browser and agent_desktop use local CLIs when enabled. MCP browser tools require their server and browser pairing. Do not claim the host lacks an MCP client. Report actual tools and connection errors; do not infer service authentication from tool availability.' };
}
export const httpTool = defineTool({ name: 'http_request', description: 'Make an HTTP(S) request, including local services. Use bearerEnv to reference an existing credential environment variable. Redirects are returned without following. Output is bounded text. Requests may have external effects; verify before retrying.',
  parameters: Type.Object({ url: Type.String(), method: Type.Optional(Type.Union(['GET','HEAD','POST','PUT','PATCH','DELETE'].map(v => Type.Literal(v)))),
    headers: Type.Optional(Type.Record(Type.String(),Type.String())), bearerEnv: Type.Optional(Type.String()), body: Type.Optional(Type.String()),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum:1, maximum:120 })), maxBytes: Type.Optional(Type.Integer({ minimum:1, maximum:100000 })) }),
  replay: 'unsafe', outputLimits: { maxBytes: 110000, maxLines: 1000 },
  execute: async (args, _api, context) => {
    const url = new URL(args.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTP(S) without credentials in the URL');
    const headers = new Headers(args.headers);
    if (args.bearerEnv) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.bearerEnv)) throw new Error('Expected credential environment variable name');
      const token=process.env[args.bearerEnv]; if (!token) throw new Error('Missing credential environment variable');
      headers.set('Authorization', 'Bearer '+token);
    }
    const timeout = AbortSignal.timeout((args.timeoutSeconds ?? 30)*1000);
    const signal = context.abortSignal ? AbortSignal.any([timeout,context.abortSignal]) : timeout;
    const response = await fetch(url, { method: args.method ?? 'GET', headers, body: args.body, redirect:'manual', signal });
    const chunks: Uint8Array[]=[]; let bytes=0, truncated=false; const limit=args.maxBytes ?? 16000;
    const reader=response.body?.getReader();
    if(reader) try { for(;;) { const {done,value}=await reader.read(); if(done)break;
      const remaining=limit-bytes; chunks.push(value.subarray(0,remaining)); bytes+=Math.min(value.length,remaining);
      if(value.length>remaining) {truncated=true;break;} }
    } finally { await reader.cancel(); }
    const data=Buffer.concat(chunks);
    const result={ status:response.status, ok:response.ok, contentType:response.headers.get('content-type'), location:response.headers.get('location'), body:data.toString('utf8'), truncated };
    return { isError: !response.ok && (response.status<300 || response.status>=400), output:[{type:'text' as const,text:JSON.stringify(result)}] };
  }
});
