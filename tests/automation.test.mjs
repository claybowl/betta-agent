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
