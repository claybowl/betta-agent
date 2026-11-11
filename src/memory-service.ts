import fs from 'node:fs/promises';
import path from 'node:path';
import { lockHome, readManifest } from './home.js';
import { git, head, compileMemory, migrateMemory, activateMemory, workingFiles, committedFiles, commitTree, digest, stateJson, parseConfig, CONFIG, recoverMemory } from './memfs.js';
import { recall } from './recall.js';
export async function locked<T>(home:string,fn:()=>Promise<T>){const release=await lockHome(home);try{await recoverMemory(home);return await fn();}finally{release();}}
export async function memoryStatus(home:string){const root=path.join(home,'memory');const revision=await head(root);const active=await stateJson(home,'memory-active.json',null);let validation:string|undefined;try{await compileMemory(root);}catch(e){validation=String(e);}let remote:string|undefined;try{remote=(await git(root,['remote','get-url','origin'])).trim();}catch{}let tracking:string|undefined;try{tracking=(await git(root,['rev-list','--left-right','--count','HEAD...@{upstream}'])).trim();}catch{}return {revision,active,validation,dirty:(await git(root,['status','--porcelain'])).trim(),remote,tracking};}
export async function memoryCommand(home:string,action:string,args:string[]=[]):Promise<unknown>{const root=path.join(home,'memory');
  if(action==='status'||!action)return memoryStatus(home);
  if(action==='browse')return (await compileMemory(root)).paths;
  if(action==='core')return compileMemory(root);
  if(action==='read'){const files=await committedFiles(root);if(!files.has(args[0]))throw new Error('Unknown committed memory file');return {revision:await head(root),path:args[0],content:files.get(args[0])};}
  if(action==='search')return (await import('./memfs.js')).searchMemory(root,args.join(' '));
  if(action==='recall')return recall(home,args.join(' '));
  if(action==='history')return git(root,['log','-20','--format=%H %aI %s%n%b']);
  if(action==='diff')return args[0]?git(root,['diff',await resolveRevision(root,args[0]),'HEAD','--']):git(root,['diff','HEAD','--']);
  if(action==='transcript-export'){if(!args[0])throw new Error('Supply a new destination JSON file');await fs.writeFile(path.resolve(args[0]),JSON.stringify(recall(home,'',200),null,2),{flag:'wx',mode:0o600});return 'Exported latest 200 recorded messages';}
  return locked(home,async()=>{
    if(action==='migrate')return migrateMemory(home);
    if(action==='refresh')return activateMemory(home);
    if(action==='commit'){await migrateMemory(home);const files=await workingFiles(root);return commitTree(home,files,`memory(manual): ${args.join(' ')||'reviewed working changes'}\n\nSources: explicit memory commit command`,digest('manual:'+JSON.stringify([...files])));}
    if(action==='revert'){const revision=await resolveRevision(root,args[0]);const files=await committedFiles(root,revision);return commitTree(home,files,`memory(revert): restore ${revision}\n\nSources: explicit revert command`,digest('revert:'+await head(root)+':'+revision));}
    if(action==='config'){const files=await committedFiles(root);if(!args.length)return parseConfig(files.get(CONFIG));const config=parseConfig(args.join(' '));files.set(CONFIG,JSON.stringify(config,null,2)+'\n');return commitTree(home,files,'memory(config): adjust memory constraints\n\nSources: explicit config command',digest('config:'+await head(root)+JSON.stringify(config)));}
    if(action==='bundle'){if(!args[0])throw new Error('Supply a new destination bundle path');const dest=path.resolve(args[0]);try{await fs.access(dest);throw new Error('Bundle destination exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await git(root,['bundle','create',dest,'--all']);return {destination:dest,includes:'Memory history and proposal branches; inspect before sharing'};}
    if(action==='remote'){if(!args[0])throw new Error('Supply remote URL or local repository path');checkRemote(args[0]);try{await git(root,['remote','get-url','origin']);await git(root,['remote','set-url','origin',args[0]]);}catch(e){await git(root,['remote','add','origin',args[0]]);}return 'Memory remote saved. Use push or pull explicitly.';}
    if(action==='push'||action==='pull'){const url=(await git(root,['remote','get-url','origin'])).trim();checkRemote(url);if((await git(root,['status','--porcelain'])).trim())throw new Error('Commit or repair drafts before synchronization');if(action==='push'){await git(root,['push','-u','origin','HEAD']);return 'Memory pushed';}
      // Fetch is inert with respect to HEAD. Validate the remote candidate, then materialize through our crash-safe transaction.
      await git(root,['fetch','origin']);const remote=(await git(root,['rev-parse','FETCH_HEAD'])).trim();const current=await head(root);await git(root,['merge-base','--is-ancestor',current,remote]);await compileMemory(root,undefined,remote);
      const files=await committedFiles(root,remote);await commitTree(home,files,`memory(sync): import ${remote}`,digest('sync:'+current+remote));
      // Preserve remote ancestry for subsequent pushes without rewriting the remote branch.
      const after=await head(root);const merge=(await git(root,['-c','user.name=Agent Memory','-c','user.email=memory@localhost','commit-tree',(await git(root,['rev-parse',`${after}^{tree}`])).trim(),'-p',after,'-p',remote,'-m',`memory(sync): preserve upstream ancestry ${remote}`])).trim();await git(root,['update-ref','HEAD',merge,after]);return 'Validated remote memory imported';}
    throw new Error('Memory commands: status, migrate, refresh, browse, core, read PATH, search QUERY, recall QUERY, diff [REV], history, commit REASON, revert REV, config [JSON], bundle PATH, remote URL, push, pull, transcript-export PATH');
  });
}
async function resolveRevision(root:string,input:string){if(!input||!/^[a-fA-F0-9]{7,64}$/.test(input))throw new Error('Supply a memory commit hash');return (await git(root,['rev-parse','--verify',`${input}^{commit}`])).trim();}
function checkRemote(value:string){if(value.startsWith('-')||value.includes('\n')||value.includes('\0')||value.includes('::'))throw new Error('Unsupported memory remote');if(/^(https?:|ssh:)/.test(value)){const url=new URL(value);if(url.password||(url.protocol.startsWith('http')&&url.username))throw new Error('Use credential helpers instead of embedding credentials');return;}if(/^git@[^:]+:.+/.test(value)||path.isAbsolute(value)||value.startsWith('./')||value.startsWith('../'))return;throw new Error('Use HTTPS, SSH, or an explicit local path');}
// Bundle import creates an isolated, new home; it never overwrites an existing agent.
export async function importMemoryBundle(bundle:string,destination:string,name:string,model:string){
  const {initHome}=await import('./home.js');const dest=path.resolve(destination);try{await fs.access(dest);throw new Error('Import destination exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const source=path.resolve(bundle);await fs.access(source);await fs.mkdir(dest);await fs.mkdir(path.join(dest,'state'));
  try{await git(dest,['clone','--no-checkout','--',source,'memory']);const root=path.join(dest,'memory');await git(root,['fetch','--update-head-ok',source,'refs/heads/*:refs/heads/*']);const imported=await committedFiles(root);if(imported.has('MEMORY.md'))await compileMemory(root);else if(![...imported.keys()].some(p=>p.startsWith('system/')&&p.endsWith('.md')))throw new Error('Bundle does not contain a supported memory layout');await git(root,['-c','core.hooksPath=/dev/null','checkout','--force']);await git(root,['remote','remove','origin']);await initHome(dest,name,model,true);await locked(dest,()=>migrateMemory(dest));return readManifest(dest);}catch(e){await fs.writeFile(path.join(dest,'IMPORT-FAILED.txt'),'Import failed; inspect before reusing this directory.\n');throw e;}
}
