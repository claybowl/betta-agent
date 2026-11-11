import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {initHome} from '../dist/home.js';
import {migrateMemory,updateMemory,digest} from '../dist/memfs.js';
import {memoryGraph} from '../dist/memory-graph.js';
import {archiveSearch,archiveRead} from '../dist/archive.js';
test('memory graph resolves relative links and backlinks from committed files only',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-graph-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await initHome(dir,'Map','faux/test');await migrateMemory(dir);
 await updateMemory(dir,[{path:'notes/a.md',content:'[Identity](../persona.md)',expectedHash:'missing'}],'Link evidence','map-test',[]);
 const graph=await memoryGraph(path.join(dir,'memory'),'persona.md');assert.match(graph,/<- notes\/a.md/);
 await fs.writeFile(path.join(dir,'memory','notes','a.md'),'uncommitted');assert.match(await memoryGraph(path.join(dir,'memory'),'notes/a.md'),/-> persona.md/);
 await assert.rejects(memoryGraph(path.join(dir,'memory'),'missing.md'),/Unknown memory path/);
});
test('historical search is isolated by home and returns source-bearing passages',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'donjon-archive-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'state'));
 const db=new DatabaseSync(path.join(dir,'state','history.sqlite'));db.exec('CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED,source UNINDEXED,text)');db.prepare('INSERT INTO documents VALUES(?,?,?)').run('one','legacy/conversation#1','Doer violet lighthouse decision');db.close();
 assert.equal(archiveSearch(dir,'violet lighthouse')[0].source,'legacy/conversation#1');assert.equal(archiveRead(dir,'one').text,'Doer violet lighthouse decision');assert.equal(archiveRead(dir,'missing'),null);assert.deepEqual(archiveSearch(dir+'-absent','Doer'),[]);assert.deepEqual(archiveSearch(dir,'" OR *'),[]);
});
