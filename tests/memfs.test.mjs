import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initHome,commitMemory} from '../dist/home.js';
import {compileMemory} from '../dist/memfs.js';
test('compiler uses a committed snapshot and routes deferred memory without loading its contents',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'memfs-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await initHome(home,'Test','faux/test');const root=path.join(home,'memory');
 await fs.mkdir(path.join(root,'projects'));await fs.writeFile(path.join(root,'projects','MEMORY.md'),'SECRET_DETAIL');await commitMemory(root,'Add routing');
 const first=await compileMemory(root);assert.match(first.core,/projects\/MEMORY.md/);assert.doesNotMatch(first.core,/SECRET_DETAIL/);
 await fs.writeFile(path.join(root,'human.md'),'UNCOMMITTED');const second=await compileMemory(root);assert.equal(second.revision,first.revision);assert.equal(second.core,first.core);
 await assert.rejects(compileMemory(root,10),/exceeds/);
});
