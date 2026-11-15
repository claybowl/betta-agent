import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'donjon-package-'));
const run = (command, args, cwd=temp) => execFileSync(command, args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']});
try {
  const packed = JSON.parse(run('npm', ['pack','--ignore-scripts','--json','--pack-destination',temp], root))[0];
  for (const file of packed.files) assert.match(file.path, /^(dist\/[^/]+\.(js|js\.map|d\.ts)|README\.md|DOER\.md|MEMORY\.md|CHANGELOG\.md|LICENSE|package\.json|npm-shrinkwrap\.json)$/);
  await fs.writeFile(path.join(temp,'package.json'), '{"private":true}');
  run('npm',['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund',path.join(temp,packed.filename)]);
  const cli = path.join(temp,'node_modules','donjon-agent','dist','cli.js');
  const home = path.join(temp,'agent');
  run(process.execPath,[cli,'init',home,'Package Test','ollama/qwen3:8b']);
  assert.match(run(process.execPath,[cli,'inspect',home]), /Package Test/);
  const api = run(process.execPath,['--input-type=module','-e',"import {runAgent} from 'donjon-agent'; if(typeof runAgent !== 'function') process.exit(1)"]);
  console.log(`Verified clean install, CLI, and runtime API: ${packed.filename}`);
} finally { await fs.rm(temp,{recursive:true,force:true}); }
