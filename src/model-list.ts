// Model choices for the picker: the runtime catalog for every provider (providers without credentials are listed too,
// marked with the environment variable they need), then each keyed provider's own /models endpoint as it answers.
// A provider key is only ever sent to that provider's catalog base URL.
import type { Models } from '@earendil-works/pi-ai';
import { appModels } from './credentials.js';

export interface ModelChoice {
  ref: string; provider: string; id: string; name: string; contextWindow?: number; costIn?: number; costOut?: number;
  /** live: the provider's API lists it now. catalog: known to the runtime, not confirmed live. unlisted: live, but unknown to the runtime. */
  state: 'live' | 'catalog' | 'unlisted';
  runnable: boolean;
  /** False when no credentials for this provider are visible to this process. */
  configured: boolean;
  /** Environment variable that supplies this provider's key, when it has one. */
  keyVar?: string;
  free?: boolean;
}
export type ModelUpdate = (choices: ModelChoice[], status: string, done: boolean) => void;
type Catalog = Pick<Models, 'getAvailable' | 'getAuth'> & Partial<Pick<Models, 'getModels'>>;
export interface StreamOptions { signal?: AbortSignal; models?: Catalog; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number }
interface Endpoint { url: string; headers: Record<string, string> }

// Copied from the runtime's key discovery (it does not export the table). Providers that use ambient credentials
// (AWS, Google ADC) have no entry.
const keyVars: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', azure: 'AZURE_OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY', 'google-vertex': 'GOOGLE_CLOUD_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY', xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', 'vercel-ai-gateway': 'AI_GATEWAY_API_KEY', zai: 'ZAI_API_KEY', 'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY', minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY', moonshotai: 'MOONSHOT_API_KEY', 'moonshotai-cn': 'MOONSHOT_API_KEY',
  huggingface: 'HF_TOKEN', fireworks: 'FIREWORKS_API_KEY', together: 'TOGETHER_API_KEY', baseten: 'BASETEN_API_KEY', opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY', 'kimi-coding': 'KIMI_API_KEY', meta: 'META_API_KEY', 'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY', xiaomi: 'XIAOMI_API_KEY', 'ant-ling': 'ANT_LING_API_KEY', radius: 'RADIUS_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
};
export const keyEnvVar = (provider: string): string | undefined => keyVars[provider];

// Providers the maintainer reaches for first; they lead the list when several have no key set. Everything else is alphabetical.
const favorites = ['opencode', 'opencode-go', 'zai', 'openrouter', 'nvidia', 'anthropic', 'openai'];
const liveProviders = new Set(['anthropic', 'openai', 'openrouter', 'google', 'groq', 'xai', 'mistral', 'deepseek', 'cerebras', 'together', 'fireworks']);
const notChat = /embed|tts|whisper|dall-e|image|audio|moderation|realtime|transcri|rerank|sora|veo|imagen|guard/i;
export function liveEndpoint(provider: string, api: string, baseUrl: string, key: string): Endpoint | undefined {
  if (!liveProviders.has(provider) || !key) return undefined;
  let base: URL;
  try { base = new URL(baseUrl); } catch { return undefined; }
  if (base.protocol !== 'https:') return undefined;
  const root = baseUrl.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return provider === 'anthropic' ? { url: root + '/v1/models?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } } : undefined;
  if (api === 'google-generative-ai') return { url: root + '/models?pageSize=1000', headers: { 'x-goog-api-key': key } };
  if (api === 'mistral-conversations') return { url: root + '/v1/models', headers: { authorization: 'Bearer ' + key } };
  if (api.startsWith('openai-')) return { url: root + '/models', headers: { authorization: 'Bearer ' + key } };
  return undefined;
}
export function parseModelList(body: any): { id: string; name: string }[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows.flatMap(row => {
    if (Array.isArray(row?.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) return [];
    const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name.replace(/^models\//, '') : '';
    return id ? [{ id, name: String(row.display_name || row.displayName || id) }] : [];
  });
}
export async function streamModels(onUpdate: ModelUpdate, opts: StreamOptions = {}): Promise<ModelChoice[]> {
  const models = opts.models ?? appModels(), doFetch = opts.fetch ?? fetch, env = opts.env ?? process.env, timeout = opts.timeoutMs ?? 8000;
  const choices = new Map<string, ModelChoice>(), notes = new Map<string, string>(), order = { live: 0, catalog: 1, unlisted: 2 };
  const jobs: { provider: string; endpoint: Endpoint; local: boolean }[] = [];
  let pending = 0;
  const rank = (provider: string) => { const i = favorites.indexOf(provider); return i < 0 ? favorites.length : i; };
  const sorted = () => [...choices.values()].map((c, i) => [c, i] as const)
    .sort((a, b) => Number(b[0].configured) - Number(a[0].configured) || rank(a[0].provider) - rank(b[0].provider) || a[0].provider.localeCompare(b[0].provider)
      || order[a[0].state] - order[b[0].state] || Number(Boolean(b[0].free)) - Number(Boolean(a[0].free)) || a[1] - b[1]).map(e => e[0]);
  const publish = () => {
    if (opts.signal?.aborted) return;
    const all = [...choices.values()], live = [...notes].map(([p, n]) => `${p} ${n}`).join(' · ');
    const keyless = new Set(all.filter(c => !c.configured).map(c => c.provider)).size, hasKeys = all.some(c => c.configured);
    const text = hasKeys || pending
      ? (live ? 'live: ' + live : 'catalog only') + (keyless ? ` · ${keyless} more providers have no key here (type a name to see what they need)` : '')
      : 'No provider keys are set in this shell. Type a provider (nvidia, opencode, zai, openrouter…) to see the variable it needs.';
    onUpdate(sorted(), text, pending === 0);
  };
  const free = (m: { cost?: { input?: number; output?: number } }) => Boolean(m.cost && m.cost.input === 0 && m.cost.output === 0);
  const endpoints = new Map<string, { api: string; baseUrl: string }>(), configured = new Set<string>();
  for (const m of await models.getAvailable()) {
    configured.add(m.provider);
    choices.set(`${m.provider}/${m.id}`, { ref: `${m.provider}/${m.id}`, provider: m.provider, id: m.id, name: m.name || m.id,
      contextWindow: m.contextWindow, costIn: m.cost?.input, costOut: m.cost?.output, state: 'catalog', runnable: true, configured: true, keyVar: keyEnvVar(m.provider), free: free(m) });
    const known = endpoints.get(m.provider);
    if (!known || (!known.api.startsWith('openai-') && String(m.api).startsWith('openai-'))) endpoints.set(m.provider, { api: String(m.api), baseUrl: m.baseUrl });
  }
  for (const m of models.getModels?.() ?? []) {
    const ref = `${m.provider}/${m.id}`;
    if (configured.has(m.provider) || choices.has(ref)) continue;
    choices.set(ref, { ref, provider: m.provider, id: m.id, name: m.name || m.id, contextWindow: m.contextWindow, costIn: m.cost?.input, costOut: m.cost?.output,
      state: 'catalog', runnable: true, configured: false, keyVar: keyEnvVar(m.provider), free: free(m) });
  }
  for (const [provider, { api, baseUrl }] of endpoints) {
    let key = '';
    try { key = (await models.getAuth(provider))?.auth.apiKey || ''; } catch { /* Catalog entries still list without a live check. */ }
    const endpoint = liveEndpoint(provider, api, baseUrl, key);
    if (endpoint) jobs.push({ provider, endpoint, local: false });
  }
  const ollama = (env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
  jobs.push({ provider: 'ollama', endpoint: { url: ollama + '/models', headers: { authorization: 'Bearer ' + (env.OLLAMA_API_KEY || 'ollama') } }, local: true });
  for (const job of jobs) if (!job.local || env.OLLAMA_BASE_URL) notes.set(job.provider, '…');
  pending = jobs.length; publish();
  await Promise.all(jobs.map(async ({ provider, endpoint, local }) => {
    try {
      const signals = [AbortSignal.timeout(local ? Math.min(timeout, 1500) : timeout)];
      if (opts.signal) signals.push(opts.signal);
      const response = await doFetch(endpoint.url, { headers: endpoint.headers, signal: AbortSignal.any(signals) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const listed = parseModelList(await response.json());
      for (const { id, name } of listed) {
        const ref = `${provider}/${id}`, known = choices.get(ref);
        if (known) known.state = 'live';
        else if (local) choices.set(ref, { ref, provider, id, name, state: 'live', runnable: true, configured: true });
        else if (!notChat.test(id)) choices.set(ref, { ref, provider, id, name, state: 'unlisted', runnable: false, configured: true, keyVar: keyEnvVar(provider) });
      }
      notes.set(provider, '✓');
    } catch (error) {
      const reason = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable';
      if (notes.has(provider)) notes.set(provider, '✗ ' + reason);
    } finally { pending--; publish(); }
  }));
  return sorted();
}

// ── Checking a provider/model reference before it is saved ────────────────────────────────────────────────────
type Checker = Pick<Models, 'getModel' | 'getModels' | 'getProvider' | 'checkAuth'>;
export interface ModelCheck {
  /** The runtime knows this model (or the provider lists models dynamically, so it cannot say). */ exists: boolean;
  /** Credentials for the provider are visible to this process. */ authed: boolean;
  keyVar?: string; problem?: string; suggestions: string[];
}
const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; } }
  return row[b.length];
};
export function suggestModels(ref: string, models: Pick<Models, 'getModels'>, limit = 5): string[] {
  const slash = ref.indexOf('/'), provider = (slash < 0 ? '' : ref.slice(0, slash)).toLowerCase();
  const tail = ref.slice(slash + 1).toLowerCase().split('/').pop() || '', tokens = tail.split(/[^a-z0-9.]+/).filter(t => t.length > 1);
  if (!tail) return [];
  const scored: { ref: string; score: number }[] = [];
  for (const m of models.getModels()) {
    const id = m.id.toLowerCase();
    let score = 0;
    if (id === tail || id.endsWith('/' + tail)) score = 100;
    else if (id.includes(tail)) score = 50;
    else { const hits = tokens.filter(t => id.includes(t)).length; if (hits < Math.min(2, tokens.length)) continue; score = hits * 5; }
    if (m.provider.toLowerCase() === provider) score += 20;
    scored.push({ ref: `${m.provider}/${m.id}`, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.ref.length - b.ref.length).slice(0, limit).map(s => s.ref);
}
export async function checkModel(ref: string, models: Checker = appModels()): Promise<ModelCheck> {
  const slash = ref.indexOf('/');
  if (slash < 1 || slash === ref.length - 1) return { exists: false, authed: false, problem: 'Model must be provider/model-id', suggestions: [] };
  const provider = ref.slice(0, slash), id = ref.slice(slash + 1);
  if (provider === 'ollama') return { exists: true, authed: true, suggestions: [] };
  const known = models.getProvider(provider);
  if (!known) {
    const names = [...new Set(models.getModels().map(m => m.provider))], typed = provider.toLowerCase();
    const near = names.filter(n => n.includes(typed) || typed.includes(n) || distance(n, typed) <= 2).slice(0, 5);
    return { exists: false, authed: false, problem: `Unknown provider "${provider}"`, suggestions: near.length ? near : [] };
  }
  const keyVar = keyEnvVar(provider), authed = Boolean(await models.checkAuth(provider).catch(() => undefined));
  if (models.getModel(provider, id) || typeof known.refreshModels === 'function') return { exists: true, authed, keyVar, suggestions: [] };
  return { exists: false, authed, keyVar, problem: `${ref} is not in this runtime's model catalog`, suggestions: suggestModels(ref, models) };
}
/** One-line next step for the provider-not-configured failure a run reports. */
export function explainRunError(message: string): string {
  const provider = message.match(/Provider is not configured: ([\w.-]+)/)?.[1];
  if (!provider) return message;
  const variable = keyEnvVar(provider);
  return message + `\n  → No credentials for "${provider}" in this shell.` + (variable ? ` Run /login ${provider}, or export ${variable} and restart. Then /resume.` : ` Run /login ${provider}. Then /resume.`);
}
