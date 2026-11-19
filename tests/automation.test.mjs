import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { automationTool, parseCommands } from '../dist/automation.js';

const fakeCli = `#!/bin/sh
if [ "$1" = "--help" ]; then printf 'Usage: agent-desktop [COMMAND]\\n\\nCommands:\\n  snapshot  Capture tree\\n  click     Click element\\n  launch    Launch app\\n\\nOptions:\\n  -h\\n'; exit 0; fi
if [ "$1" = "status" ]; then echo '{"ok":true,"command":"status"}'; exit 0; fi
echo "{\\"ok\\":false,\\"error\\":{\\"code\\":\\"INVALID_ARGS\\",\\"message\\":\\"error: unrecognized subcommand '$1'\\"}}"; exit 2
`;
test('agent_desktop rejects shell-style guesses with the real command list and passes envelopes through', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'betta-auto-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true });
  const exe = path.join(home, '.local', 'bin', 'agent-desktop'); await fs.writeFile(exe, fakeCli, { mode: 0o755 });
  const saved = process.env.HOME; process.env.HOME = home; t.after(() => { process.env.HOME = saved; });
  const tool = automationTool('agent-desktop', home);
  assert.match(tool.description, /NOT a shell/);
  const bad = await tool.execute({ args: ['touch', '/tmp/x'] }, {}, {});
  assert.equal(bad.isError, true);
  assert.match(bad.output[0].text, /"touch" is not an agent-desktop command/);
  assert.match(bad.output[0].text, /Valid commands: snapshot, click, launch\./);
  assert.doesNotMatch(bad.output[0].text, /Command failed/);
  const ok = await tool.execute({ args: ['status'] }, {}, {});
  assert.equal(ok.isError, false); assert.equal(JSON.parse(ok.output[0].text).command, 'status');
});
test('parseCommands stops at the next section', () => {
  assert.deepEqual(parseCommands('Commands:\n  a  x\n  b-c  y\n\nOptions:\n  -h  help\n'), ['a', 'b-c']);
});

test('tool previews unwrap JSON envelopes into short readable lines', async () => {
  const { toolPreview } = await import('../dist/tui.js');
  const guide = JSON.stringify({ ok: true, data: { content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') } });
  const shown = toolPreview(guide);
  assert.match(shown, /^ {2}line 0\n {2}line 1\n/); assert.doesNotMatch(shown, /\\n/);
  assert.match(shown, /… 28 more lines/);
  assert.match(toolPreview('{"a":1}'), /"a": 1/);
});
test('run failures name the model and the way out', async () => {
  const { runFailureMessage } = await import('../dist/harness.js');
  assert.match(runFailureMessage({ reason: 'model_error', detail: 'Request timed out.' }, 'p/m'), /p\/m did not respond.*\/model/);
  assert.match(runFailureMessage({ reason: 'turn_limit' }, 'p/m'), /turn limit/);
});

test('provider error bodies become one readable line, including nested Gemini errors', async () => {
  const { runFailureMessage } = await import('../dist/harness.js');
  const gemini = JSON.stringify({ error: { message: JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan.' } }, null, 2) } });
  const m = runFailureMessage({ reason: 'model_error', detail: gemini }, 'google/x');
  assert.match(m, /429 You exceeded your current quota/); assert.match(m, /billing or rate limit/); assert.doesNotMatch(m, /[{}]/);
  assert.match(runFailureMessage({ reason: 'model_error', detail: '402 {"error":{"message":"Insufficient credits."}}' }, 'o/x'), /402 Insufficient credits\./);
});
test('bash defaults to a bounded timeout and says each call is a fresh shell', async () => {
  const { boundedBash, DEFAULT_BASH_TIMEOUT_SECONDS } = await import('../dist/harness.js');
  const seen = []; const tool = boundedBash({ name: 'bash', description: 'Run.', execute: async a => seen.push(a) });
  await tool.execute({ command: 'x' }); await tool.execute({ command: 'y', timeout: 900 });
  assert.equal(seen[0].timeout, DEFAULT_BASH_TIMEOUT_SECONDS); assert.equal(seen[1].timeout, 900);
  assert.match(tool.description, /fresh shell/); assert.match(tool.description, /Stdin is closed/);
});
test('agents saved with the old 50-turn default move to the new default; other choices are kept', async t => {
  const { initHome } = await import('../dist/home.js'); const { readSettings, saveSettings, DEFAULT_MAX_TURNS } = await import('../dist/settings.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betta-turns-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await initHome(dir, 'T', 'faux/test'); const s = await readSettings(dir); assert.equal(s.maxTurns, DEFAULT_MAX_TURNS);
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ ...s, maxTurns: 50 })); assert.equal((await readSettings(dir)).maxTurns, DEFAULT_MAX_TURNS);
  s.maxTurns = 30; await saveSettings(dir, s); assert.equal((await readSettings(dir)).maxTurns, 30);
});
