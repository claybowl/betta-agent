import { hash } from './home.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { Connection, AgentSettings } from './settings.js';
import type { Emit } from './harness.js';
type Server = { client: Client; config: string; tools: ToolRegistration<any>[] };
export class Connections {
  private signal?: AbortSignal;
  private emit: Emit = () => {};
  private servers = new Map<string, Server>();
  readonly errors = new Map<string, string>();
  status(name: string) { return this.servers.has(name) ? 'active' : this.errors.has(name) ? 'error' : 'inactive'; }
  tools() { return [...this.servers.values()].flatMap(s => s.tools); }
  async close() { await Promise.allSettled([...this.servers.values()].map(s => s.client.close())); this.servers.clear(); this.errors.clear(); }
  async sync(settings: AgentSettings, cwd: string, emit: Emit = () => {}, signal?: AbortSignal) {
    this.signal = signal; this.emit = emit;
    const wanted = settings.permissions.mcp ? settings.connections.filter(c => c.enabled) : [];
    for (const [name, s] of this.servers) if (!wanted.some(c => c.name === name && JSON.stringify([c,cwd]) === s.config)) { await s.client.close(); this.servers.delete(name); this.errors.delete(name); }
    for (const c of wanted) {
      signal?.throwIfAborted();
      if (this.servers.has(c.name)) continue;
      const client = new Client({ name: 'donjon-agent', version: '0.1.0' });
      try {
        const env = Object.fromEntries(Object.entries(c.env || {}).map(([key, source]) => {
          const value = process.env[source]; if (value === undefined) throw new Error(`Missing environment variable ${source}`); return [key,value];
        }));
        const headers: Record<string,string> = {};
        if (c.bearerEnv) { const token = process.env[c.bearerEnv]; if (!token) throw new Error(`Missing environment variable ${c.bearerEnv}`); headers.Authorization = `Bearer ${token}`; }
        const transport = c.transport === 'stdio'
          ? new StdioClientTransport({ command: c.command!, args: c.args, env, cwd, stderr: 'pipe' })
          : new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers } });
        if (transport instanceof StdioClientTransport) transport.stderr?.on('data', chunk => emit({ type: 'connection_log', name: c.name, text: String(chunk) }));
        await client.connect(transport, { timeout: 10_000, signal });
        const registered: ToolRegistration<any>[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listTools({ cursor }, { timeout: 10_000, signal });
          for (const tool of page.tools) {
            if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tool.name)) throw new Error(`Unsupported tool name: ${tool.name}`);
            registered.push(defineTool({ name: `mcp_${c.name.slice(0,16)}_${tool.name.slice(0,28)}_${hash(c.name + "\0" + tool.name).slice(0,8)}`, description: tool.description || tool.name,
              parameters: tool.inputSchema, replay: 'unsafe', outputLimits: { maxBytes: 16000, maxLines: 300 },
              execute: async (args, _api, context) => {
                const signals = [this.signal, context.abortSignal].filter((s): s is AbortSignal => Boolean(s));
                const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { timeout: 60_000, signal: signals.length ? AbortSignal.any(signals) : undefined,
                  onprogress: p => this.emit({ type: 'connection_log', name: c.name, text: p.message || `Progress: ${p.progress}${p.total ? '/' + p.total : ''}` }) });
                return { isError: Boolean(result.isError), output: [{ type: 'text' as const, text: JSON.stringify(result.content ?? result) }] };
              } }));
          }
          cursor = page.nextCursor;
          if (registered.length > 200 || (cursor && cursors.has(cursor))) throw new Error('Server tool discovery exceeded limits');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        this.servers.set(c.name, { client, config: JSON.stringify([c,cwd]), tools: registered });
        this.errors.delete(c.name);
        client.onclose = () => { this.servers.delete(c.name); this.errors.set(c.name, 'Connection closed'); };
        emit({ type: 'connection', name: c.name, status: 'active', tools: registered.length });
      } catch (error) {
        await client.close().catch(() => {});
        this.errors.set(c.name, String(error));
        emit({ type: 'connection', name: c.name, status: 'error', message: String(error) });
      }
    }
  }
}
