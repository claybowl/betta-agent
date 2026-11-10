import fs from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineDoc, defineExtension, defineTool, section, type Submission, type SubmissionId, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createProvider, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "typebox";
import { commitMemory, coreMemory, hash, lockHome, readManifest, readMemory, writeMemory } from "./home.js";

type UsageTotals = { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number };
const totals = (usage: { models: Record<string, { input: number; output: number; cacheRead: number; cost: { total: number } }> }): UsageTotals =>
  Object.values(usage.models).reduce((sum, u) => ({ inputTokens: sum.inputTokens + u.input,
    outputTokens: sum.outputTokens + u.output, cachedInputTokens: sum.cachedInputTokens + u.cacheRead,
    costUsd: sum.costUsd + u.cost.total }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 });
type Pending = { submission: SubmissionId; conversation: ConversationId; requestId: string; model: string; cwd: string; memory: string; env: Record<string, string>; usageStart: UsageTotals };
const State = defineDoc<{ conversations: Record<string, ConversationId>; pending: Pending | null }>({
  kind: "donjon.runtime", version: 1, scope: "session",
  initial: () => ({ conversations: {}, pending: null }), checkpointWhen: () => true,
});
export interface RunInput {
  home: string; cwd?: string; memoryDir?: string; model?: string; baseUrl?: string;
  prompt?: string; requestId?: string; sessionKey?: string; instructions?: string; resumeOnly?: boolean; allowShell?: boolean;
}
export interface RunResult {
  sessionId: string; requestId: string; summary: string; recovered: boolean;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  costUsd: number;
}
export type Emit = (event: Record<string, unknown>) => void;

export async function makeModels(model: string, baseUrl?: string): Promise<Models> {
  const models = builtinModels();
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash), id = model.slice(slash + 1);
  if (provider === "ollama") {
    const url = baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    models.setProvider(createProvider({ id: "ollama", name: "Ollama", baseUrl: url,
      auth: { apiKey: { name: "Local Ollama", resolve: async () => ({ auth: { apiKey: process.env.OLLAMA_API_KEY || "ollama" } }) } },
      models: [{ id, name: id, api: "openai-completions", provider, baseUrl: url, reasoning: false,
        input: ["text"], contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], api: openAICompletionsApi() }));
  } else if (baseUrl) throw new Error("Custom baseUrl currently supported only for Ollama");
  await models.refresh({ providers: [provider] });
  if (!models.getModel(provider, id)) throw new Error(`Unknown model: ${model}`);
  return models;
}

export async function runAgent(input: RunInput, emit: Emit = () => {}, suppliedModels?: Models, signal?: AbortSignal): Promise<RunResult> {
  const home = await fs.realpath(input.home);
  const manifest = await readManifest(home);
  const cwd = await fs.realpath(input.cwd || home);
  const memory = await fs.realpath(input.memoryDir || path.join(home, "memory"));
  if (memory !== await fs.realpath(path.join(home, "memory"))) throw new Error("Bind Doer memory to agentHome/memory so interactive use and export share the same memory.");
  const release = await lockHome(home);
  let harness: Harness | undefined;
  let starting: UsageTotals | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const selected = input.model || manifest.model;
    const split = selected.indexOf("/");
    if (split < 1) throw new Error("Model must be provider/model-id");
    const models = suppliedModels || await makeModels(selected, input.baseUrl);
    const registry = createRegistry();
    const memoryExtension = defineExtension({ name: "agent-memory", sections: [section("memory", async () =>
      `Your persistent memory lives at ${memory}. Core files below are refreshed before every model request.\n` +
      "Read deeper Markdown files on demand. Use memory_read then memory_write with the returned sha256 to update durable knowledge. " +
      "Record important facts, preferences, decisions, and unfinished work while working; do not rely on the chat transcript alone. " +
      "Keep core memory small and put reference material in indexed subdirectories. Never store credentials.\n" + await coreMemory(memory))],
      tools: [
        defineTool({ name: "memory_read", description: "Read a memory Markdown file and its version hash. A new path returns sha256=missing.",
          parameters: Type.Object({ path: Type.String() }), replay: "safe",
          execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await readMemory(memory, (args as { path: string }).path)) }] }) }),
        defineTool({ name: "memory_write", description: "Atomically replace memory using the hash from memory_read; safe to replay after interruption.",
          parameters: Type.Object({ path: Type.String(), content: Type.String(), expectedHash: Type.String() }), replay: "safe",
          execute: async (args) => {
            const a = args as { path: string; content: string; expectedHash: string };
            const result = await writeMemory(memory, a.path, a.content, a.expectedHash);
            emit({ type: "memory", path: a.path, sha256: result.sha256 });
            return { output: [{ type: "text", text: JSON.stringify({ sha256: result.sha256 }) }] };
          } }),
      ] });
    registry.install(memoryExtension);
    registry.install(CodingTools);
    registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }));
    harness = await Harness.open(await openNodeSqliteStorage(path.join(home, "state", "runtime.sqlite")), {
      models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd || cwd }),
      settings: { toolExecution: "sequential", compaction: { enabled: true }, retry: { maxRetries: 2 } },
    }, context);
    const runtime = harness;
    const before = await runtime.usage(context);
    starting = totals(before);
    abortHandler = () => {
      void (async () => {
        const state = await runtime.snapshot(State, context);
        if (state?.pending) {
          const conversation = await runtime.conversation(state.pending.conversation, context);
          await conversation?.abort(context);
          await runtime.commit(async tx => { (await tx.doc(State)).pending = null; }, context);
        }
      })().catch(error => emit({ type: "error", message: String(error) }));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    const settle = async (submission: Submission) => {
      const result = await submission.wait(context);
      if (result.status !== "done" || result.type !== "input") {
        await runtime.commit(async tx => { (await tx.doc(State)).pending = null; }, context);
        throw new Error(`Run did not complete: ${JSON.stringify(result)}`);
      }
      const entry = await runtime.commit(tx => tx.entry(AssistantEntry, result.answer), context);
      return (entry?.model || []).flatMap(message => message.role === "assistant" ? message.content.filter(c => c.type === "text").map(c => c.text) : []).join("\n");
    };
    await runtime.commit(async tx => { await tx.doc(State); }, context);
    let state = (await runtime.snapshot(State, context))!;
    let recovered = false;
    let summary = "";
    let requestId = input.requestId || "";
    let conversationId: ConversationId | undefined;
    if (state.pending) {
      const pending = state.pending;
      starting = pending.usageStart || starting;
      if (pending.model !== selected) throw new Error(`Resume unfinished work with ${pending.model} before changing models.`);
      if (pending.cwd !== "@agent-home" && path.resolve(pending.cwd) !== cwd) throw new Error(`Unfinished work belongs to ${pending.cwd}. Resume there before starting work in ${cwd}.`);
      if (pending.memory !== "@agent-memory" && pending.memory !== memory) throw new Error("Unfinished work uses a different memory binding. Restore the original binding to resume.");
      conversationId = pending.conversation;
      const pendingConversation = await runtime.conversation(pending.conversation, context);
      await pendingConversation?.configure({ cwd, tools: (input.allowShell ?? manifest.allowShell) ? null : [...(CodingTools.tools || []).filter(t => t.name === "read"), ...(memoryExtension.tools || [])] }, context);
      emit({ type: "recovery", requestId: pending.requestId });
      // Restore task attribution, but use the current worker's fresh credentials.
      const keys = ["DOER_RUN_ID", "DOER_TASK_ID", "DOER_WAKE_REASON"];
      const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
      for (const key of keys) { if (pending.env[key]) process.env[key] = pending.env[key]; else delete process.env[key]; }
      try { const pendingSubmission = await runtime.submission(pending.submission, context);
        if (!pendingSubmission) throw new Error("Pending submission is missing");
        summary = await settle(pendingSubmission); }
      finally { for (const key of keys) { if (saved[key] !== undefined) process.env[key] = saved[key]; else delete process.env[key]; } }
      await runtime.commit(async tx => { (await tx.doc(State)).pending = null; }, context);
      recovered = true;
      if (input.resumeOnly || requestId === pending.requestId) {
        requestId = pending.requestId;
        input = { ...input, resumeOnly: true };
      }
      state = (await runtime.snapshot(State, context))!;
    }
    if (!input.resumeOnly) {
      signal?.throwIfAborted();
      if (!input.prompt || !requestId) throw new Error("A prompt and stable requestId are required");
      const key = hash(`${input.sessionKey || "main"}\n${cwd === home ? "@agent-home" : cwd}`);
      conversationId = state.conversations[key];
      if (!conversationId) {
        conversationId = await runtime.commit(async tx => {
          const doc = await tx.doc(State);
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          doc.conversations[key] = conversation.id;
          return conversation.id;
        }, context);
      }
      const conversation = await runtime.conversation(conversationId, context);
      if (!conversation) throw new Error("Stored conversation is missing");
      await conversation.configure({ model: { provider: selected.slice(0, split), modelId: selected.slice(split + 1) },
        cwd, maxTurns: 50, instructions: `${manifest.instructions}\n${input.instructions || ""}\nSkills are in ${path.join(home, "skills")}. Read relevant SKILL.md files before using them.`,
        tools: (input.allowShell ?? manifest.allowShell) ? null : [...(CodingTools.tools || []).filter(t => t.name === "read"), ...(memoryExtension.tools || [])],
      }, context);
      // Submission and pending pointer are one transaction: there is no crash window between them.
      const submission = await runtime.commit(async tx => {
        const submission = await conversation.submit(tx, { type: "input", content: input.prompt!, requestId });
        (await tx.doc(State)).pending = { submission, conversation: conversationId!, requestId, model: selected, cwd: cwd === home ? "@agent-home" : cwd,
          memory: memory === path.join(home, "memory") ? "@agent-memory" : memory,
          usageStart: starting!,
          env: Object.fromEntries(["DOER_RUN_ID", "DOER_TASK_ID", "DOER_WAKE_REASON"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : [])) };
        return submission;
      }, context);
      emit({ type: "init", sessionId: String(conversationId || ""), requestId, model: selected });
      if (signal?.aborted) abortHandler();
      const handle = await runtime.submission(submission, context);
      if (!handle) throw new Error("Submission missing after commit");
      summary = await settle(handle);
      await runtime.commit(async tx => { (await tx.doc(State)).pending = null; }, context);
    }
    await commitMemory(memory, `Agent run ${requestId || "recovery"}`);
    const after = totals(await runtime.usage(context));
    const result: RunResult = { sessionId: String(conversationId || ""), requestId, summary: summary || "No unfinished work.", recovered,
      usage: { inputTokens: after.inputTokens - starting.inputTokens, outputTokens: after.outputTokens - starting.outputTokens,
        cachedInputTokens: after.cachedInputTokens - starting.cachedInputTokens }, costUsd: after.costUsd - starting.costUsd };
    emit({ type: "result", ...result });
    return result;
  } catch (error) {
    if (harness && starting) {
      const after = totals(await harness.usage(context));
      emit({ type: "result", errorMessage: error instanceof Error ? error.message : String(error),
        usage: { inputTokens: after.inputTokens - starting.inputTokens, outputTokens: after.outputTokens - starting.outputTokens,
          cachedInputTokens: after.cachedInputTokens - starting.cachedInputTokens }, costUsd: after.costUsd - starting.costUsd });
    }
    throw error;
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    try { await harness?.close(context); } finally { release(); }
  }
}
