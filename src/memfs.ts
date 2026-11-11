import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface MemorySnapshot { revision: string; core: string; paths: string[] }
const git = async (root: string, ...args: string[]) => (await exec('git',['-C',root,...args],{maxBuffer:4*1024*1024})).stdout;
export function parseBlock(text: string) {
  if (!text.startsWith('---\n')) return { description: '', body: text };
  const end = text.indexOf('\n---\n',4);
  if (end < 0) throw new Error('Unterminated memory frontmatter');
  const metadata = text.slice(4,end);
  const description = metadata.match(/^description:\s*(.*)$/m)?.[1] || '';
  return {description,body:text.slice(end+5)};
}
export async function compileMemory(root: string, maximumCharacters = 24000): Promise<MemorySnapshot> {
  const revision = (await git(root,'rev-parse','--verify','HEAD')).trim();
  const paths = (await git(root,'ls-tree','-r','--name-only',revision)).trim().split('\n').filter(Boolean);
  if (!paths.includes('MEMORY.md')) throw new Error('Memory requires a root MEMORY.md index');
  const blocks: string[] = [];
  for (const file of paths.filter(p=>!p.includes('/')&&p.endsWith('.md')&&p!=='MEMORY.md').sort()) {
    const name=file.slice(0,-3);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`Invalid core memory block name: ${name}`);
    const {description,body}=parseBlock(await git(root,'show',`${revision}:${file}`));
    blocks.push(`<${name}>\n${description ? `<description>${description}</description>\n` : ''}${body.trimEnd()}\n</${name}>`);
  }
  const index=await git(root,'show',`${revision}:MEMORY.md`);
  const directories=paths.filter(p=>/^[a-zA-Z0-9_-]+\/MEMORY\.md$/.test(p)&&!p.startsWith('skills/'));
  blocks.push(`<memory>\n${index.trimEnd()}${directories.length ? '\n<deferred-memory>\n'+directories.map(p=>`<directory path="${p.slice(0,-9)}" index="${p}" />`).join('\n')+'\n</deferred-memory>' : ''}\n</memory>`);
  const core=blocks.join('\n\n');
  if(core.length>maximumCharacters) throw new Error(`Compiled core memory exceeds ${maximumCharacters} characters`);
  return {revision,core,paths};
}
