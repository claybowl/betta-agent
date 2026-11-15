import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { initHome, exportHome } from '../dist/home.js';
import { runAgent } from '../dist/harness.js';
import { doerConfig, DoerClient, reportCost, DOER_RESTORED_ENV } from '../dist/doer.js';
import { fakeDoer, run, COMPANY, AGENT, OTHER_AGENT, KEY } from './doer-server.mjs';

const fixture = fileURLToPath(new URL('./doer-crash-worker.mjs', import.meta.url));
const DOER_KEYS = ['DOER_API_URL', 'DOER_API_KEY', 'DOER_COMPANY_ID', 'DOER_AGENT_ID', ...DOER_RESTORED_ENV];
async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'donjon-doer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await initHome(dir, 'Test', 'faux/test');
  return dir;
}
function fake(responses, cost) {
  const models = createModels(), faux = fauxProvider({ models: [{ id: 'test', ...(cost ? { cost } : {}) }] });
  models.setProvider(faux.provider); faux.setResponses(responses);
  return { models, faux };
}
// Doer is switched on through the process environment only, exactly as the process adapter does it.
function withEnv(t, env) {
  const before = Object.fromEntries(DOER_KEYS.map(k => [k, process.env[k]]));
  for (const k of DOER_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => { for (const k of DOER_KEYS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
}
const child = (args, env) => new Promise(resolve => {
  // Asynchronous on purpose: the fake Doer lives in this process and must keep answering.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DOER_')));
  const proc = spawn(process.execPath, [fixture, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', c => stdout += c); proc.stderr.on('data', c => stderr += c);
  const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
  proc.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
});
const toolCall = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const sent = (doer, method, route) => doer.requests.filter(r => r.method === method && r.route === route);

test('Doer stays off unless all four variables are set, and standalone runs make no Doer calls', async t => {
  const doer = await fakeDoer(t), dir = await home(t);
  assert.equal(doerConfig({}), null);
  for (const missing of ['DOER_API_URL', 'DOER_API_KEY', 'DOER_COMPANY_ID', 'DOER_AGENT_ID']) assert.equal(doerConfig({ ...doer.env, [missing]: '' }), null, missing);
  assert.equal(doerConfig(doer.env).agentId, AGENT);
  const { DOER_API_KEY, ...partial } = doer.env;
  withEnv(t, partial);
  const { models } = fake([ctx => { assert.doesNotMatch(JSON.stringify(ctx), /doer_|running under Doer/); return fauxAssistantMessage('Standalone.'); }]);
  const events = [];
  // Without Doer a missing request id is still an error, as before.
  await assert.rejects(runAgent({ home: dir, prompt: 'Hi' }, undefined, fake([]).models), /stable requestId/);
  const result = await runAgent({ home: dir, prompt: 'Hi', requestId: 'solo' }, e => events.push(e), models);
  assert.equal(result.summary, 'Standalone.'); assert.equal(result.requestId, 'solo');
  assert.equal(doer.requests.length, 0);
  assert.equal(events.filter(e => e.type === 'doer').length, 0);
});

test('under Doer the run id becomes the request id, wake context is read, and a repeated wake runs once', async t => {
  const doer = await fakeDoer(t), dir = await home(t), runId = randomUUID(), issue = randomUUID();
  doer.state.runs = [run(runId, 'running'), run(randomUUID(), 'running', { agentId: OTHER_AGENT }), run(randomUUID(), 'succeeded')];
  doer.state.runDetails[runId] = { ...run(runId, 'running'), contextSnapshot: { wakeReason: 'issue_assigned', issueId: issue, wakeCommentId: 'comment-7' } };
  withEnv(t, doer.env);
  const events = [];
  const first = fake([ctx => {
    const seen = JSON.stringify(ctx);
    for (const name of ['doer_approval_request', 'doer_approval_read', 'doer_approval_issues', 'doer_approval_comment', 'doer_approval_resubmit', 'doer_approvals_mine', 'doer_inbox', 'doer_issue_read', 'doer_issue_comments', 'doer_issue_checkout', 'doer_issue_update', 'doer_issue_comment']) assert.match(seen, new RegExp(name));
    // Deciding approvals is the board's job: no such tool exists.
    assert.doesNotMatch(seen, /doer_approval_(approve|reject|decide|request_revision)/);
    assert.match(seen, new RegExp(`Run: ${runId}`)); assert.match(seen, /issue_assigned/); assert.match(seen, new RegExp(issue));
    assert.doesNotMatch(seen, new RegExp(KEY));
    // Shell tools see the same wake variables Doer's other adapters pass.
    assert.equal(process.env.DOER_RUN_ID, runId); assert.equal(process.env.DOER_TASK_ID, issue); assert.equal(process.env.DOER_WAKE_COMMENT_ID, 'comment-7');
    return fauxAssistantMessage('Heartbeat done.');
  }]);
  const result = await runAgent({ home: dir, prompt: 'Heartbeat' }, e => events.push(e), first.models);
  assert.equal(result.requestId, runId); assert.equal(result.summary, 'Heartbeat done.');
  assert.equal(process.env.DOER_RUN_ID, undefined, 'wake variables are removed after the run');
  assert.equal(sent(doer, 'GET', `/companies/${COMPANY}/heartbeat-runs`)[0].query.agentId, AGENT);
  assert.ok(doer.requests.every(r => r.headers.authorization === `Bearer ${KEY}`));
  assert.equal(events.find(e => e.event === 'startup').runId, runId);
  // Doer wakes the same run again (or the process is started twice): the model is not called a second time.
  const again = fake([]);
  const repeat = await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, again.models);
  assert.equal(repeat.summary, 'Heartbeat done.'); assert.equal(repeat.requestId, runId); assert.equal(again.faux.state.callCount, 0);
  // A new Doer run is new work.
  const next = randomUUID(); doer.state.runs = [run(next, 'running'), run(runId, 'succeeded')];
  const third = fake([fauxAssistantMessage('Next heartbeat.')]);
  assert.equal((await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, third.models)).requestId, next);
});

test('when Doer cannot be reached the run proceeds as before and does not claim deduplication', async t => {
  const dir = await home(t);
  withEnv(t, { DOER_API_URL: 'http://127.0.0.1:9', DOER_API_KEY: KEY, DOER_COMPANY_ID: COMPANY, DOER_AGENT_ID: AGENT });
  const events = [];
  const one = fake([fauxAssistantMessage('Ran anyway.')]);
  const first = await runAgent({ home: dir, prompt: 'Heartbeat' }, e => events.push(e), one.models);
  assert.equal(first.summary, 'Ran anyway.');
  const unavailable = events.find(e => e.event === 'startup_unavailable');
  assert.match(unavailable.message, /deduplication is off/); assert.doesNotMatch(JSON.stringify(events), new RegExp(KEY));
  // No stable id was available, so a second start is a second run rather than a silent replay.
  const two = fake([fauxAssistantMessage('Ran again.')]);
  const second = await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, two.models);
  assert.notEqual(second.requestId, first.requestId); assert.equal(two.faux.state.callCount, 1);
});

test('work killed by a failed run is recovered; work killed by a cancelled run is not resumed', async t => {
  for (const [status, expectRecovered] of [['failed', true], ['timed_out', true], ['cancelled', false]]) {
    const doer = await fakeDoer(t), dir = await home(t), first = randomUUID(), second = randomUUID();
    doer.state.runs = [run(first, 'running')];
    const crashed = await child([dir, 'crash'], doer.env);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr + crashed.stdout);
    // Doer records how the first run ended, then starts the next heartbeat.
    doer.state.runs = [run(second, 'running'), run(first, status)];
    const restarted = await child([dir, 'next', ...(expectRecovered ? ['Recovered job.', 'Fresh heartbeat.'] : ['Fresh heartbeat.'])], doer.env);
    assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout);
    const out = JSON.parse(restarted.stdout.trim());
    assert.equal(out.result.recovered, expectRecovered, status);
    assert.equal(out.result.summary, 'Fresh heartbeat.'); assert.equal(out.result.requestId, second);
    const dropped = out.events.find(e => e.event === 'cancelled_work_dropped');
    if (expectRecovered) { assert.equal(dropped, undefined); assert.equal(out.events.find(e => e.type === 'recovery').requestId, first); assert.equal(out.calls, 2); }
    else { assert.equal(dropped.runId, first); assert.equal(dropped.requestId, first); assert.equal(out.calls, 1, 'the cancelled job never reached the model again'); }
    // Unfinished work is saved without the agent key, and nothing in the home contains it.
    for (const file of await fs.readdir(path.join(dir, 'state'))) assert.equal((await fs.readFile(path.join(dir, 'state', file))).includes(KEY), false, file);
  }
});

test('unfinished work that did not start under this Doer agent is never dropped on a cancelled run', async t => {
  const doer = await fakeDoer(t), dir = await home(t), second = randomUUID();
  // Started standalone (no Doer variables), then crashed.
  const crashed = await child([dir, 'crash'], {});
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stderr + crashed.stdout, /stable requestId/, 'standalone without a request id is rejected as in 0.3.0');
  const standalone = fileURLToPath(new URL('./crash-worker.mjs', import.meta.url));
  const solo = await new Promise(resolve => { const p = spawn(process.execPath, [standalone, dir, 'crash'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DOER_'))), stdio: 'ignore' }); p.on('close', (status, signal) => resolve({ status, signal })); });
  assert.equal(solo.signal, 'SIGKILL');
  doer.state.runs = [run(second, 'running'), run(randomUUID(), 'cancelled')];
  const restarted = await child([dir, 'next', 'Recovered job.', 'Fresh heartbeat.'], doer.env);
  assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout);
  const out = JSON.parse(restarted.stdout.trim());
  assert.equal(out.result.recovered, true); assert.equal(out.events.some(e => e.event === 'cancelled_work_dropped'), false);
});

test('approval tools use Doer as the only record and refuse secrets', async t => {
  const doer = await fakeDoer(t), dir = await home(t), runId = randomUUID(), issue = randomUUID(), returned = randomUUID();
  doer.state.runs = [run(runId, 'running')];
  doer.state.approvals = [
    { id: returned, companyId: COMPANY, type: 'approve_ceo_strategy', status: 'revision_requested', requestedByAgentId: AGENT, payload: { plan: 'v1' }, decisionNote: 'Add a budget.' },
    { id: randomUUID(), companyId: COMPANY, type: 'hire_agent', status: 'pending', requestedByAgentId: OTHER_AGENT, payload: {} },
  ];
  withEnv(t, doer.env);
  let created;
  const { models } = fake([
    toolCall('doer_approval_request', { type: 'approve_ceo_strategy', payload: { plan: 'Launch the pilot.' }, issueIds: [issue] }),
    ctx => { created = doer.state.approvals.at(-1); assert.match(JSON.stringify(ctx), new RegExp(created.id)); return toolCall('doer_approval_request', { type: 'hire_agent', payload: { name: 'Helper', token: KEY } }); },
    ctx => { assert.match(JSON.stringify(ctx), /contains a credential/); return toolCall('doer_approval_comment', { id: created.id, body: 'Context for the board.' }); },
    () => toolCall('doer_approval_resubmit', { id: returned, payload: { plan: 'v2 with a budget' } }),
    () => toolCall('doer_approval_resubmit', { id: created.id }),
    ctx => { assert.match(JSON.stringify(ctx), /Only revision requested/); return toolCall('doer_approval_issues', { id: created.id }); },
    ctx => { assert.match(JSON.stringify(ctx), new RegExp(issue)); return toolCall('doer_approvals_mine', {}); },
    ctx => { const seen = JSON.stringify(ctx); assert.match(seen, new RegExp(returned)); assert.doesNotMatch(seen, new RegExp(OTHER_AGENT)); return toolCall('doer_approval_read', { id: '../companies' }); },
    ctx => { assert.match(JSON.stringify(ctx), /Invalid Doer identifier/); return fauxAssistantMessage('Approvals handled.'); },
  ]);
  const result = await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, models);
  assert.equal(result.summary, 'Approvals handled.');
  const creates = sent(doer, 'POST', `/companies/${COMPANY}/approvals`);
  assert.equal(creates.length, 1, 'the request carrying a secret never left the process');
  assert.deepEqual(creates[0].body, { type: 'approve_ceo_strategy', payload: { plan: 'Launch the pilot.' }, issueIds: [issue] });
  assert.equal('requestedByAgentId' in creates[0].body, false);
  assert.equal(creates[0].headers['x-doer-run-id'], runId, 'mutations are linked to the heartbeat run');
  assert.equal(sent(doer, 'POST', `/approvals/${created.id}/comments`)[0].body.body, 'Context for the board.');
  assert.deepEqual(sent(doer, 'POST', `/approvals/${returned}/resubmit`)[0].body, { payload: { plan: 'v2 with a budget' } });
  assert.equal(doer.state.approvals.find(a => a.id === returned).status, 'pending');
  // The agent never calls a deciding endpoint, and betta wrote no approval list of its own.
  assert.equal(doer.requests.some(r => /\/(approve|reject|request-revision)$/.test(r.route)), false);
  const stateFiles = await fs.readdir(path.join(dir, 'state'));
  assert.equal(stateFiles.some(f => /approval/i.test(f)), false, stateFiles.join(','));
  // Tool calls are journaled like any other tool, without the key.
  const journal = await fs.readFile(path.join(dir, 'state', 'actions.jsonl'), 'utf8');
  assert.match(journal, /doer_approval_request/); assert.doesNotMatch(journal, new RegExp(KEY));
  assert.match(journal, /\[REDACTED\]/, 'a secret the model put in tool arguments is journaled redacted');
});

test('a wake for a decided approval is briefed first, with this agent\'s rejected and returned approvals', async t => {
  const doer = await fakeDoer(t), dir = await home(t), runId = randomUUID(), approved = randomUUID(), rejected = randomUUID(), old = randomUUID(), returned = randomUUID(), foreign = randomUUID(), issue = randomUUID();
  const lastGood = new Date(Date.now() - 3600_000).toISOString();
  doer.state.runs = [run(runId, 'running'), run(randomUUID(), 'succeeded', { startedAt: lastGood })];
  doer.state.runDetails[runId] = { ...run(runId, 'running'), contextSnapshot: { source: 'approval.approved', wakeReason: 'approval_approved', approvalId: approved, approvalStatus: 'approved', issueId: issue, issueIds: [issue], taskId: issue } };
  const mine = { companyId: COMPANY, type: 'approve_ceo_strategy', requestedByAgentId: AGENT, payload: {} };
  doer.state.approvals = [
    { ...mine, id: approved, status: 'approved', payload: { plan: 'The approved plan' } },
    { ...mine, id: rejected, status: 'rejected', decisionNote: 'Too expensive.', decidedAt: new Date().toISOString() },
    { ...mine, id: old, status: 'rejected', decisionNote: 'Old news.', decidedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
    { ...mine, id: returned, status: 'revision_requested', decisionNote: 'Needs dates.' },
    { ...mine, id: foreign, status: 'rejected', requestedByAgentId: OTHER_AGENT, decidedAt: new Date().toISOString() },
  ];
  doer.state.approvalIssues[approved] = [{ id: issue, title: 'Ship the pilot' }];
  withEnv(t, doer.env);
  const events = [];
  const { models } = fake([ctx => {
    const seen = JSON.stringify(ctx);
    assert.match(seen, new RegExp(`decision on approval ${approved}`)); assert.match(seen, /The approved plan/); assert.match(seen, /Ship the pilot/);
    assert.match(seen, new RegExp(rejected)); assert.match(seen, /Too expensive/);
    assert.match(seen, new RegExp(returned)); assert.match(seen, /doer_approval_resubmit/);
    assert.doesNotMatch(seen, new RegExp(old), 'rejections from before the last completed run are not repeated');
    assert.doesNotMatch(seen, new RegExp(foreign), 'another agent\'s approvals are not this agent\'s business');
    assert.equal(process.env.DOER_APPROVAL_ID, approved); assert.equal(process.env.DOER_APPROVAL_STATUS, 'approved'); assert.equal(process.env.DOER_LINKED_ISSUE_IDS, issue);
    return fauxAssistantMessage('Followed up.');
  }]);
  await runAgent({ home: dir, prompt: 'Heartbeat' }, e => events.push(e), models);
  assert.deepEqual(sent(doer, 'GET', `/companies/${COMPANY}/approvals`).map(r => r.query.status).sort(), ['rejected', 'revision_requested']);
  const checked = events.find(e => e.event === 'approvals_checked');
  assert.equal(checked.rejected, 1); assert.equal(checked.revisionRequested, 1);
});

test('work tools read the inbox and update issues the way Doer\'s skill describes', async t => {
  const doer = await fakeDoer(t), dir = await home(t), runId = randomUUID(), issue = randomUUID();
  doer.state.runs = [run(runId, 'running')]; doer.state.inbox = [{ id: issue, identifier: 'DON-1', title: 'Fixture issue', status: 'todo' }];
  withEnv(t, doer.env);
  const { models } = fake([
    toolCall('doer_inbox', {}),
    ctx => { assert.match(JSON.stringify(ctx), /DON-1/); return toolCall('doer_issue_checkout', { id: issue }); },
    () => toolCall('doer_issue_read', { id: issue }),
    () => toolCall('doer_issue_comments', { id: issue, after: 'c0' }),
    () => toolCall('doer_issue_comment', { id: issue, body: 'Working on it.' }),
    () => toolCall('doer_issue_update', { id: issue, status: 'done', comment: 'Finished.', deliverableExemption: 'No file output.' }),
    () => { doer.state.checkoutConflict = true; return toolCall('doer_issue_checkout', { id: issue }); },
    ctx => { assert.match(JSON.stringify(ctx), /checked out by another agent/); assert.match(JSON.stringify(ctx), /Do not retry/); return fauxAssistantMessage('Issues handled.'); },
  ]);
  assert.equal((await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, models)).summary, 'Issues handled.');
  assert.equal(sent(doer, 'GET', '/agents/me/inbox-lite').length, 1);
  const checkout = sent(doer, 'POST', `/issues/${issue}/checkout`)[0];
  assert.deepEqual(checkout.body, { agentId: AGENT, expectedStatuses: ['todo', 'backlog', 'blocked'] }); assert.equal(checkout.headers['x-doer-run-id'], runId);
  assert.equal(sent(doer, 'GET', `/issues/${issue}/heartbeat-context`).length, 1);
  assert.deepEqual(sent(doer, 'GET', `/issues/${issue}/comments`)[0].query, { order: 'asc', after: 'c0' });
  assert.equal(sent(doer, 'POST', `/issues/${issue}/comments`)[0].body.body, 'Working on it.');
  assert.deepEqual(sent(doer, 'PATCH', `/issues/${issue}`)[0].body, { status: 'done', comment: 'Finished.', deliverableExemption: 'No file output.' });
});

test('real usage is reported to Doer for this agent, and a failed report never fails the run', async t => {
  const doer = await fakeDoer(t), dir = await home(t), runId = randomUUID(), issue = randomUUID();
  doer.state.runs = [run(runId, 'running')];
  doer.state.runDetails[runId] = { ...run(runId, 'running'), contextSnapshot: { wakeReason: 'timer', issueId: issue } };
  withEnv(t, doer.env);
  const events = [];
  const result = await runAgent({ home: dir, prompt: 'Heartbeat' }, e => events.push(e), fake([fauxAssistantMessage('Some words that use tokens.')]).models);
  const route = `/companies/${COMPANY}/cost-events`;
  const [report] = sent(doer, 'POST', route);
  assert.ok(result.usage.inputTokens + result.usage.outputTokens > 0, 'the fixture model reports usage');
  assert.equal(report.body.agentId, AGENT); assert.equal(report.body.heartbeatRunId, runId); assert.equal(report.body.issueId, issue);
  assert.equal(report.body.provider, 'faux'); assert.equal(report.body.model, 'test');
  assert.equal(report.body.inputTokens, result.usage.inputTokens); assert.equal(report.body.outputTokens, result.usage.outputTokens);
  assert.equal(report.body.costCents, Math.round(result.costUsd * 100));
  assert.ok(Number.isInteger(report.body.costCents) && !Number.isNaN(Date.parse(report.body.occurredAt)));
  assert.equal(events.some(e => e.event === 'cost_reported'), true);
  // Dollars become whole cents the way Doer stores them (the fixture model is free, so check the conversion directly).
  const before = sent(doer, 'POST', route).length;
  await reportCost(new DoerClient(doerConfig(doer.env)), { reachable: true, runs: [], wake: {}, runId: 'not-a-uuid' }, { model: 'anthropic/some-model', inputTokens: 1200.4, outputTokens: 30, cachedInputTokens: 0, costUsd: 0.126 }, () => {});
  const direct = sent(doer, 'POST', route)[before].body;
  assert.equal(direct.costCents, 13); assert.equal(direct.inputTokens, 1200); assert.equal(direct.provider, 'anthropic'); assert.equal(direct.model, 'some-model');
  assert.equal('heartbeatRunId' in direct, false, 'only real run ids are attached');
  assert.equal(await reportCost(new DoerClient(doerConfig(doer.env)), { reachable: true, runs: [], wake: {} }, { model: 'faux/test', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }, () => {}), false);
  assert.equal(sent(doer, 'POST', route).length, before + 1, 'a run that spent nothing reports nothing');
  // The same run replayed spends nothing, so nothing more is reported.
  await runAgent({ home: dir, prompt: 'Heartbeat' }, undefined, fake([]).models);
  assert.equal(sent(doer, 'POST', route).length, before + 1);
  // Doer's cost endpoint failing is logged and does not change the run's outcome.
  const next = randomUUID(); doer.state.runs = [run(next, 'running')]; doer.state.costStatus = 500;
  const failures = [];
  const second = await runAgent({ home: dir, prompt: 'Heartbeat' }, e => failures.push(e), fake([fauxAssistantMessage('Still fine.')]).models);
  assert.equal(second.summary, 'Still fine.'); assert.equal(failures.some(e => e.event === 'cost_report_failed'), true);
});

test('the agent key stays out of exports, the journal, recall and saved work', async t => {
  const doer = await fakeDoer(t), dir = await home(t), parent = await fs.mkdtemp(path.join(os.tmpdir(), 'donjon-doer-export-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  doer.state.runs = [run(randomUUID(), 'running')];
  withEnv(t, doer.env);
  const events = [];
  // Even when the model repeats the key, recall stores it redacted.
  await runAgent({ home: dir, prompt: 'Heartbeat' }, e => events.push(e), fake([fauxAssistantMessage(`The key is ${KEY}.`)]).models);
  await exportHome(dir, path.join(parent, 'copy'), false); await exportHome(dir, path.join(parent, 'continuation'), true);
  const walk = async root => (await fs.readdir(root, { withFileTypes: true, recursive: true })).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
  for (const root of [dir, parent]) for (const file of await walk(root)) {
    if (file.endsWith('runtime.sqlite') || file.includes('runtime.sqlite-')) continue; // the transcript holds what the model itself said
    assert.equal((await fs.readFile(file)).includes(KEY), false, file);
  }
  assert.doesNotMatch(JSON.stringify(events.filter(e => e.type === 'doer')), new RegExp(KEY));
});

// End to end through the CLI, the way Doer's process adapter starts it: `donjon-agent run HOME PROMPT` plus environment.
// The model is a local OpenAI-compatible fixture reached through the built-in Ollama provider.
async function fakeModel(t, reply) {
  const http = await import('node:http');
  const state = { calls: 0, hold: false, waiting: [] };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    state.calls++;
    if (state.hold) { state.waiting.forEach(r => r()); return; } // never answers: the run is mid-request when Doer stops it
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { state, url: `http://127.0.0.1:${server.address().port}/v1` };
}
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function startCli(args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DOER_')));
  const proc = spawn(process.execPath, [cli, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', c => stdout += c); proc.stderr.on('data', c => stderr += c);
  const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
  const done = new Promise(resolve => proc.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); }));
  return { proc, done };
}

test('the CLI run command works as a Doer process-adapter command and stops cleanly on Doer\'s signal', { skip: process.platform === 'win32' && 'Windows has no SIGTERM delivery; the startup check covers it' }, async t => {
  const doer = await fakeDoer(t), model = await fakeModel(t, 'Heartbeat complete.'), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'donjon-doer-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await initHome(dir, 'Cli', 'ollama/test');
  const env = { ...doer.env, OLLAMA_BASE_URL: model.url }, first = randomUUID(), second = randomUUID(), third = randomUUID();
  doer.state.runs = [run(first, 'running')];
  const ok = await startCli(['run', dir, 'Standing heartbeat prompt'], env).done;
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(ok.stdout.trim(), 'Heartbeat complete.');
  assert.match(ok.stderr, /\[doer\] .*"event":"startup"/); assert.match(ok.stderr, new RegExp(first));
  assert.doesNotMatch(ok.stderr + ok.stdout, new RegExp(KEY));
  const report = sent(doer, 'POST', `/companies/${COMPANY}/cost-events`)[0].body;
  assert.equal(report.heartbeatRunId, first); assert.equal(report.inputTokens, 40); assert.equal(report.outputTokens, 6); assert.equal(report.provider, 'ollama');
  // Doer stops the next run mid-request with SIGTERM (its stop and timeout signal on macOS and Linux).
  doer.state.runs = [run(second, 'running'), run(first, 'succeeded')]; model.state.hold = true;
  const stopped = startCli(['run', dir, 'Standing heartbeat prompt'], env);
  await new Promise(resolve => model.state.waiting.push(resolve));
  stopped.proc.kill('SIGTERM');
  const ended = await stopped.done;
  assert.notEqual(ended.status, 0, 'a stopped run does not report success'); assert.equal(ended.signal, null, 'it exited on its own, without needing a hard kill');
  // The stop was honored locally, so the next heartbeat has nothing to resume, whatever status Doer recorded.
  model.state.hold = false; const callsBefore = model.state.calls;
  doer.state.runs = [run(third, 'running'), run(second, 'failed'), run(first, 'succeeded')];
  const after = await startCli(['run', dir, 'Standing heartbeat prompt'], env).done;
  assert.equal(after.status, 0, after.stderr + after.stdout);
  assert.equal(model.state.calls, callsBefore + 1, 'one model call for the new heartbeat only');
  assert.doesNotMatch(after.stderr, /recover/i);
});
