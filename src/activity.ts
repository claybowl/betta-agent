import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { Emit } from './harness.js';
import { redact } from './recall.js';
export type Action = { id: string; time: string; name: string; status: 'started' | 'completed' | 'error' | 'unknown'; detail?: string };
export class Activity {
  constructor(readonly home: string, readonly emit: Emit) {}
  record(action: Omit<Action, 'time'>) {
    const event: Action = { ...action, time: new Date().toISOString() };
    const fd = fs.openSync(path.join(this.home, 'state', 'actions.jsonl'), 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.emit({ type: 'action', ...event });
  }
  wrap(tool: ToolRegistration<any>): ToolRegistration<any> {
    return defineTool({ ...tool, execute: async (args, api, context) => {
      const id = randomUUID();
      // Persist intent before invoking anything that can have an external effect.
      // Arguments are written with known credentials removed: a model can paste a secret into any tool call.
      this.record({ id, name: tool.name, status: 'started', detail: tool.name === 'http_request' ? JSON.stringify({ method: args.method || 'GET', url: (() => { try { const u = new URL(args.url); return u.origin + u.pathname; } catch { return '[invalid URL]'; } })() }) : redact(JSON.stringify(args)).slice(0, 2000) });
      try {
        const result = await tool.execute(args, api, context);
        this.record({ id, name: tool.name, status: result.isError ? 'error' : 'completed', detail: result.isError ? 'Tool returned an error; partial effects may remain.' : 'Tool returned a result. External effects may need verification.' });
        this.emit({ type: 'tool_result', name: tool.name, output: result.output });
        return result;
      } catch (error) {
        this.record({ id, name: tool.name, status: 'unknown', detail: redact(String(error)) });
        throw error;
      }
    } });
  }
}
export function readActions(home: string): Action[] {
  let text: string;
  try { text = fs.readFileSync(path.join(home, 'state', 'actions.jsonl'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const actions = new Map<string, Action>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const a = JSON.parse(line) as Action; actions.set(a.id, a); } catch { /* A crash may truncate the final line. */ }
  }
  return [...actions.values()].map(a => a.status === 'started' ? { ...a, status: 'unknown', detail: 'No completion receipt. Inspect the affected files or service before retrying.' } : a);
}
