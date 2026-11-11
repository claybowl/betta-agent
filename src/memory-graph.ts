import path from 'node:path';
import { committedFiles, head } from './memfs.js';
export async function memoryGraph(root:string,focus='') {
 const revision=await head(root), files=await committedFiles(root,revision);
 const nodes=[...files.keys()].filter(p=>p.endsWith('.md')).sort();
 const edges=new Map<string,Set<string>>();
 for(const p of nodes){const refs=new Set<string>();const text=files.get(p)!;
  for(const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\)/g)){
   let target=(m[1]||m[2]).split('#')[0].trim();if(!target||/^[a-z]+:/i.test(target)||target.startsWith('/'))continue;
   try{target=decodeURIComponent(target);}catch{continue;}
   const candidates=[target,path.posix.normalize(path.posix.join(path.posix.dirname(p),target))];
   for(const c of candidates.flatMap(c=>[c,c+'.md',c+'/MEMORY.md']))if(files.has(c)){refs.add(c);break;}
  }edges.set(p,refs);
 }
 const clean=(s:string)=>s.replace(/[\x00-\x1f\x7f-\x9f]/g,'?');
 const lines=['MEMORY GRAPH · '+revision.slice(0,12),'[core] loaded each turn · [ref] retrieved on demand',''];
 if(focus){if(!files.has(focus))throw new Error('Unknown memory path; use /memory graph to browse');lines.push(clean(focus));for(const target of edges.get(focus)||[])lines.push('  -> '+clean(target));for(const [p,refs]of edges)if(refs.has(focus))lines.push('  <- '+clean(p));if(lines.length===4)lines.push('  (No explicit Markdown or wiki links)');}
 else {const groups=new Map<string,string[]>();for(const p of nodes){const group=p.includes('/')?p.split('/')[0]:'Core';groups.set(group,[...(groups.get(group)||[]),p]);}for(const [g,items]of groups){lines.push('+- '+g+' ('+items.length+')');for(const p of items.slice(0,12))lines.push('|  +- '+clean(p)+(g==='Core'?' [core]':' [ref]')+' · '+(edges.get(p)?.size||0)+' links');if(items.length>12)lines.push('|  ... '+(items.length-12)+' more; /memory graph PATH shows links');}}
 return lines.join('\n')+'\n\nOpen: /memory read PATH · Search: /memory search QUERY\nOnly explicit Markdown/wiki links are shown; no inferred relationships.';
}
