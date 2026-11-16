// Stored provider logins (API keys pasted with /login, and OAuth tokens from subscription sign-in) live in one
// owner-only file under the app config directory. Environment variables still work and need no entry here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Credential, CredentialInfo, CredentialStore, MutableModels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { configRoot, atomicJson } from './settings.js';

const file = () => path.join(configRoot(), 'credentials.json');
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
async function load(): Promise<Record<string, Credential>> {
  try { const data = JSON.parse(await fs.readFile(file(), 'utf8')); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
}
export class FileCredentialStore implements CredentialStore {
  read(providerId: string) { return serial(async () => (await load())[providerId]); }
  list() { return serial(async (): Promise<CredentialInfo[]> => Object.entries(await load()).map(([providerId, c]) => ({ providerId, type: c.type }))); }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return serial(async () => {
      const all = await load(), next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next; await atomicJson(file(), all); return next;
    });
  }
  delete(providerId: string) { return serial(async () => { const all = await load(); if (providerId in all) { delete all[providerId]; await atomicJson(file(), all); } }); }
}
/** The runtime catalog wired to stored logins. Use this everywhere instead of bare builtinModels(). */
export function appModels(): MutableModels { return builtinModels({ credentials: new FileCredentialStore() }); }
/** Stable per-install ID some sign-in flows require. Created on first use. */
export async function deviceId(): Promise<string> {
  const at = path.join(configRoot(), 'device-id');
  try { const id = (await fs.readFile(at, 'utf8')).trim(); if (/^[0-9a-f-]{36}$/i.test(id)) return id; } catch { /* Created below. */ }
  const id = randomUUID(); await fs.mkdir(configRoot(), { recursive: true }); await fs.writeFile(at, id + '\n', { mode: 0o600 }); return id;
}
// Subscription sign-in is offered only where the vendor permits it in third-party tools.
// Anthropic's terms reserve Claude Pro/Max sign-in for Claude Code and claude.ai, so it is not offered; an API key works.
export const subscriptionBlocked: Record<string, string> = {
  anthropic: "Anthropic's terms reserve Claude Pro/Max sign-in for Claude Code and claude.ai. Use an Anthropic API key here instead.",
};
