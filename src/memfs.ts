import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
const exec = promisify(execFile);
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const CONFIG = '.memfs.config.json';
export interface MemoryConfig { version: 1; maxDepth: number; maxFileCharacters: number; maxCoreMemoryCharacters: number; readOnlyFiles: string[]; fileCharacterLimits: { pattern: string; limit: number | null }[] }
export const defaults: MemoryConfig = { version: 1, maxDepth: 4, maxFileCharacters: 20000, maxCoreMemoryCharacters: 24000, readOnlyFiles: [], fileCharacterLimits: [] };
export interface MemorySnapshot { revision: string; core: string; paths: string[]; characters: number; estimatedTokens: number; format: 'v2' | 'legacy'; config: MemoryConfig }
export async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return (await exec('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 8*1024*1024, env: { ...process.env, ...env } })).stdout;
}
export async function head(root: string) { return (await git(root,['rev-parse','--verify','HEAD'])).trim(); }
export function safePath(p: string, config = false) {
  if (config && p === CONFIG) return;
  if (!p || p.includes('\\') || p.startsWith('/') || p.split('/').some(s => !s || s.startsWith('.') || !/^[A-Za-z0-9_ .-]+$/.test(s)) || /[\r\n\0]/.test(p)) throw new Error(`Invalid memory path: ${p}`);
}
export function glob(pattern: string, value: string) {
  if (typeof pattern !== 'string' || pattern.length > 300) throw new Error('Invalid memory glob');
  let s = '^';
  for(let i=0;i<pattern.length;i++) { const c=pattern[i]; if(c==='*') { if(pattern[i+1]==='*') { i++; s += pattern[i+1]==='/' ? (i++, '(?:.*/)?') : '.*'; } else s+='[^/]*'; } else if(c==='?') s+='[^/]'; else s+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  return new RegExp(s+'$').test(value);
}
export function parseConfig(text?: string): MemoryConfig {
  const raw = text ? JSON.parse(text) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid MemFS configuration');
  const c = { ...defaults, ...raw } as MemoryConfig;
  if (c.version!==1 || ![c.maxDepth,c.maxFileCharacters,c.maxCoreMemoryCharacters].every(Number.isInteger) || c.maxDepth<1 || c.maxDepth>12 || c.maxFileCharacters<100 || c.maxFileCharacters>128000 || c.maxCoreMemoryCharacters<100 || c.maxCoreMemoryCharacters>65536 || !Array.isArray(c.readOnlyFiles) || !Array.isArray(c.fileCharacterLimits)) throw new Error('Invalid MemFS limits');
  for (const p of c.readOnlyFiles) glob(p,'');
  for (const r of c.fileCharacterLimits) { glob(r.pattern,''); if(r.limit!==null && (!Number.isInteger(r.limit)||r.limit<1||r.limit>128000)) throw new Error('Invalid per-file memory limit'); }
  return c;
}
export function parseBlock(text: string) {
  text=text.replace(/\r\n/g,'\n');
  if (!text.startsWith('---\n')) return { description:'', body:text, name:'' };
  const end=text.indexOf('\n---\n',4); if(end<0) throw new Error('Unterminated memory frontmatter');
  const fields: Record<string,string> = {};
  for(const line of text.slice(4,end).split('\n')) { const m=line.match(/^(name|description):\s*(.*)$/); if(!m || fields[m[1]]!==undefined) throw new Error('Core frontmatter requires name and description'); fields[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2'); }
  if(!fields.name || !fields.description) throw new Error('Core frontmatter requires name and description');
  return {name:fields.name,description:fields.description,body:text.slice(end+5)};
}
export function secretLike(text: string) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ant-|ghp_)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b/.test(text)) return true;
  return Object.entries(process.env).some(([k,v]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(k) && v && v.length>=12 && text.includes(v));
}
export function validateTree(files: Map<string,string>, previous?: Map<string,string>) {
  const config=parseConfig(files.get(CONFIG));
  if(!files.has('MEMORY.md')) throw new Error('Memory requires root MEMORY.md');
  let core=0;
  for(const [p,text] of files) {
    safePath(p,true); if(secretLike(text) && previous?.get(p)!==text) throw new Error(`Possible credential in ${p}; reference its environment variable instead`);
    if(!p.endsWith('.md')) continue;
    if(Buffer.byteLength(text)>128000) throw new Error(`${p} exceeds 128 KB`);
    const skill=p.startsWith('skills/');
    const limit=config.fileCharacterLimits.find(r=>glob(r.pattern,p))?.limit;
    if([...text].length>(limit===null?128000:limit??config.maxFileCharacters)) throw new Error(`${p} exceeds file character limit`);
    if(!skill && p.split('/').length-1>config.maxDepth) throw new Error(`${p} exceeds memory depth`);
    if(!skill) {
      const parts=p.split('/');parts.pop();let dir='';for(const part of parts){dir+=(dir?'/':'')+part;if(!files.has(dir+'/MEMORY.md')) throw new Error(`${p}: missing index ${dir}/MEMORY.md`);}
      if(!p.includes('/')) { core += [...text].length; if(p==='MEMORY.md') { if(text.startsWith('---')) throw new Error('MEMORY.md must not have frontmatter'); } else { const block=parseBlock(text); if(block.name && block.name!==p.slice(0,-3)) throw new Error(`${p}: frontmatter name must match filename`); } }
    }
  }
  if(core>config.maxCoreMemoryCharacters) throw new Error('Core memory exceeds configured character budget');
  if(previous) for(const p of new Set([...files.keys(),...previous.keys()])) if(previous.get(p)!==files.get(p) && parseConfig(previous.get(CONFIG)).readOnlyFiles.some(g=>glob(g,p))) throw new Error(`${p} is read-only`);
  return config;
}
export async function committedFiles(root: string, revision?: string) {
  const rev=revision||await head(root); if(!/^[a-f0-9]{40,64}$/.test(rev)) throw new Error('Use a full memory revision');
  const tree=(await git(root,['ls-tree','-r','-z',rev])).split('\0').filter(Boolean);
  if(tree.length>1000) throw new Error('Memory exceeds 1000 files');
  const files=new Map<string,string>();let bytes=0;
  for(const entry of tree) {const m=entry.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/s);if(!m||!['100644','100755'].includes(m[1]))throw new Error('Memory symlinks and submodules are unsupported');const p=m[3];safePath(p,true);const text=await git(root,['show',`${rev}:${p}`]);bytes+=Buffer.byteLength(text);if(bytes>4*1024*1024)throw new Error('Memory exceeds 4 MB');files.set(p,text);}
  return files;
}
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderTree(files: Map<string,string>, maximumCharacters?:number) {
  const config=validateTree(files);const blocks:string[]=[];
  for(const p of [...files.keys()].filter(p=>!p.includes('/')&&p.endsWith('.md')&&p!=='MEMORY.md').sort()) {const name=p.slice(0,-3);if(!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))throw new Error(`Invalid core block: ${name}`);const b=parseBlock(files.get(p)!);blocks.push(`<${name}>\n${b.description?`<description>${xml(b.description)}</description>\n`:''}${b.body.trimEnd()}\n</${name}>`);}
  const dirs=[...files.keys()].filter(p=>/^[^/]+\/MEMORY\.md$/.test(p)&&!p.startsWith('skills/')).sort();
  blocks.push(`<memory>\n${files.get('MEMORY.md')!.trimEnd()}${dirs.length?'\n<deferred-memory>\n'+dirs.map(p=>`<directory path="${xml(p.slice(0,-9))}" index="${xml(p)}" />`).join('\n')+'\n</deferred-memory>':''}\n</memory>`);
  const core=blocks.join('\n\n');if(core.length>Math.min(maximumCharacters??config.maxCoreMemoryCharacters,config.maxCoreMemoryCharacters))throw new Error('Compiled core memory exceeds character budget');return {core,config};
}
const compilationCache=new Map<string,MemorySnapshot>();
export async function compileMemory(root:string, maximumCharacters?:number, revision?:string):Promise<MemorySnapshot> {
  const rev=revision||await head(root);const key=root+'|'+rev+'|'+maximumCharacters;const cached=compilationCache.get(key);if(cached)return structuredClone(cached);const files=await committedFiles(root,rev);const {core,config}=renderTree(files,maximumCharacters);
  const result:MemorySnapshot={revision:rev,core,paths:[...files.keys()],characters:[...core].length,estimatedTokens:Math.ceil(Buffer.byteLength(core)/3),format:files.has(CONFIG)?'v2':'legacy',config};if(compilationCache.size>=20)compilationCache.delete(compilationCache.keys().next().value!);compilationCache.set(key,result);return structuredClone(result);
}
export async function workingFiles(root:string) {
  const files=new Map<string,string>();let bytes=0;
  const walk=async(dir:string)=>{for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name==='.git')continue;const p=path.relative(root,path.join(dir,e.name)).split(path.sep).join('/');safePath(p,true);if(e.isSymbolicLink())throw new Error(`Memory symlink: ${p}`);if(e.isDirectory())await walk(path.join(dir,e.name));else if(e.isFile()){const st=await fs.stat(path.join(dir,e.name));bytes+=st.size;if(bytes>4*1024*1024||files.size>=1000)throw new Error('Memory working tree exceeds limits');files.set(p,await fs.readFile(path.join(dir,e.name),'utf8'));}}};await walk(root);return files;
}
async function atomic(file:string,value:unknown) {await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}await fs.rename(temp,file);}
export async function stateJson<T>(home:string,name:string,fallback:T):Promise<T>{try{return JSON.parse(await fs.readFile(path.join(home,'state',name),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw e;}}
export async function saveState(home:string,name:string,value:unknown){await atomic(path.join(home,'state',name),value);}
// Caller holds the home ownership lock. Commit the complete tree before materializing it.
export async function recoverMemory(home:string) {
  const j=await stateJson<any>(home,'memory-transaction.json',null);if(!j)return;
  const root=path.join(home,'memory');const current=await head(root);
  if(current!==j.revision && current!==j.base)throw new Error('Memory transaction conflicts with HEAD; retain journal for repair');
  if(current===j.base)await git(root,['update-ref','HEAD',j.revision,j.base]);
  for(const c of j.changes as {path:string;old:string|null;content:string|null}[]){safePath(c.path,true);const file=path.join(root,c.path);let old:string|null=null;try{const stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new Error('Memory symlink');old=await fs.readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(old!==c.content&&old!==c.old)throw new Error(`Working copy changed during transaction: ${c.path}`);
    // Reject symlinked parent components, including a missing leaf.
    let parent=root;for(const part of c.path.split('/').slice(0,-1)){parent=path.join(parent,part);try{if((await fs.lstat(parent)).isSymbolicLink())throw new Error('Memory parent symlink');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    if(c.content===null)await fs.rm(file,{force:true});else {await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,c.content,{mode:0o600});}
  }
  await git(root,['read-tree',j.revision]);await fs.rm(path.join(home,'state','memory-transaction.json'));
}
export async function commitTree(home:string, files:Map<string,string>, message:string, transactionId:string) {
  if(secretLike(message))throw new Error('Possible credential in memory commit message');
  const root=path.join(home,'memory');await recoverMemory(home);const base=await head(root);const previous=await committedFiles(root,base);
  const found=(await git(root,['log','-1','--format=%H','--fixed-strings','--grep',`Transaction-ID: ${transactionId}`])).trim();if(found)return found;
  validateTree(files,previous);renderTree(files);
  const changed=[...new Set([...files.keys(),...previous.keys()])].filter(p=>files.get(p)!==previous.get(p));if(!changed.length)return base;
  const working=await workingFiles(root);const changes=changed.map(p=>({path:p,old:working.get(p)??null,content:files.get(p)??null}));
  const index=path.join(home,'state',`index-${randomUUID()}`);const env={GIT_INDEX_FILE:index,GIT_AUTHOR_NAME:'Agent Memory',GIT_AUTHOR_EMAIL:'memory@localhost',GIT_COMMITTER_NAME:'Agent Memory',GIT_COMMITTER_EMAIL:'memory@localhost'};
  const staging=await fs.mkdtemp(path.join(home,'state','stage-'));
  try {await git(root,['read-tree','--empty'],env);for(const [p,content]of files){const f=path.join(staging,randomUUID());await fs.writeFile(f,content);const blob=(await git(root,['hash-object','-w','--',f],env)).trim();await git(root,['update-index','--add','--cacheinfo','100644',blob,p],env);}const tree=(await git(root,['write-tree'],env)).trim();const revision=(await git(root,['commit-tree',tree,'-p',base,'-m',`${message}\n\nTransaction-ID: ${transactionId}`],env)).trim();await saveState(home,'memory-transaction.json',{base,revision,changes});await recoverMemory(home);return revision;}
  finally{await fs.rm(index,{force:true});await fs.rm(staging,{recursive:true,force:true});}
}
export async function migrateMemory(home:string) {
  await recoverMemory(home);const root=path.join(home,'memory');try{await fs.access(path.join(root,CONFIG));return await activateMemory(home);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const files=await workingFiles(root);
  // Preserve the original revision in Git. Legacy system/ core files move to root; collisions require human resolution.
  for(const [p,v]of [...files])if(p.startsWith('system/')&&p.endsWith('.md')){const to=p.slice(7).replaceAll('/','_');if(files.has(to))throw new Error(`Legacy core collision: ${to}`);files.set(to,v.startsWith('---\n')?v.replace(/^name:.*$/m,`name: ${to.slice(0,-3)}`):v);files.delete(p);}
  if(!files.has('MEMORY.md'))files.set('MEMORY.md','# Memory\n\nOpen the indexed directories below when their topic is relevant.\n');
  for(const [p,v]of [...files]){if(!p.endsWith('.md')||p.startsWith('skills/'))continue;if(!p.includes('/')&&p!=='MEMORY.md'&&!v.startsWith('---\n'))files.set(p,`---\nname: ${p.slice(0,-3)}\ndescription: ${p.slice(0,-3)} memory\n---\n${v}`);const dirs=p.split('/').slice(0,-1);let dir='';for(const d of dirs){dir+=(dir?'/':'')+d;if(!files.has(dir+'/MEMORY.md'))files.set(dir+'/MEMORY.md',`# ${d}\n\n${[...files.keys()].filter(f=>f.startsWith(dir+'/')).map(f=>'- '+f.slice(dir.length+1)).join('\n')}\n`);}}
  // Preserve valid existing large files within supported limits rather than truncating their content.
  const largest=Math.max(20000,...[...files.values()].map(s=>[...s].length));files.set(CONFIG,JSON.stringify({...defaults,maxFileCharacters:Math.min(128000,largest)},null,2)+'\n');
  const routes=[...files.keys()].filter(p=>/^[^/]+\/MEMORY\.md$/.test(p)&&!p.startsWith('skills/'));if(routes.length)files.set('MEMORY.md',files.get('MEMORY.md')+'\nDeferred topics:\n'+routes.map(p=>'- '+p.split('/')[0]+': '+p).join('\n')+'\n');
  await commitTree(home,files,`memory(migration): adopt MemFS v2\n\nPreserved source revision ${await head(root)}; originals remain in Git.`,digest('migration:'+await head(root)));
  return compileMemory(root);
}
export async function activateMemory(home:string, maximumCharacters?:number) {
  const root=path.join(home,'memory');await recoverMemory(home);
  const old=await stateJson<{revision:string}|null>(home,'memory-active.json',null);
  try{const snapshot=await compileMemory(root,maximumCharacters);await saveState(home,'memory-active.json',{revision:snapshot.revision,characters:snapshot.characters,estimatedTokens:snapshot.estimatedTokens,activatedAt:new Date().toISOString()});return {...snapshot,warning:undefined as string|undefined};}
  catch(e){if(!old)throw e;const snapshot=await compileMemory(root,maximumCharacters,old.revision);return {...snapshot,warning:`Using last valid memory: ${String(e)}`};}
}
export interface MemoryChange {path:string;content:string|null;expectedHash:string}
export async function updateMemory(home:string,changes:MemoryChange[],message:string,id:string,sources:string[]) {
  const root=path.join(home,'memory');await recoverMemory(home);const files=await committedFiles(root);
  const already=(await git(root,['log','-1','--format=%H','--fixed-strings','--grep',`Transaction-ID: ${id}`])).trim();if(already)return already;
  if(!changes.length||changes.length>50||new Set(changes.map(c=>c.path)).size!==changes.length)throw new Error('Memory changes require 1–50 unique paths');
  for(const c of changes){safePath(c.path);if(!c.path.endsWith('.md'))throw new Error('Memory tools edit Markdown only');const old=files.get(c.path);const working=await workingFiles(root);if(working.get(c.path)!==old)throw new Error(`Uncommitted draft conflicts with ${c.path}`);if(c.expectedHash!==(old===undefined?'missing':digest(old)))throw new Error(`Memory changed: ${c.path}; read again`);if(c.content===null)files.delete(c.path);else files.set(c.path,c.content);}
  // Add routing indexes for newly created deferred paths in the same transaction.
  for(const c of changes)if(c.content!==null&&!c.path.startsWith('skills/')){let dir='';for(const d of c.path.split('/').slice(0,-1)){dir+=(dir?'/':'')+d;if(!files.has(dir+'/MEMORY.md'))files.set(dir+'/MEMORY.md',`# ${d}\n\n- ${c.path}\n`);}}
  return commitTree(home,files,`memory(self): ${message.slice(0,200)}\n\nSources:\n${sources.map(s=>'- '+s).join('\n')}`,id);
}
export async function searchMemory(root:string,query:string,revision?:string) {
  const rev=revision||await head(root);const files=await committedFiles(root,rev);const terms=query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)||[];if(!terms.length)return [];
  return [...files].filter(([p])=>p.endsWith('.md')).flatMap(([p,text])=>{const lines=text.split('\n');const hits=lines.flatMap((line,i)=>{const lower=line.toLowerCase();const score=terms.reduce((s,t)=>s+(lower.includes(t)?1:0),0);return score?[{path:p,line:i+1,text:line.slice(0,600),score,revision:rev}]:[];});return hits;}).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,20);
}
