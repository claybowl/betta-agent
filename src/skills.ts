import { committedFiles, head } from './memfs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const bundledRoot = fileURLToPath(new URL('../skills/', import.meta.url));
export async function operatingBrief() { return fs.readFile(path.join(bundledRoot,'betta-agent','SKILL.md'),'utf8'); }
export interface Skill { name: string; description: string; file: string; /** Display name from frontmatter, when it differs from the catalog name. */ title?: string; source: 'memory' | 'home' | 'bundled' }
export interface SkippedSkill { path: string; reason: string }
const isSkillFile = (name: string) => /^skill\.md$/i.test(name);
/** Top-level keys of a leading YAML frontmatter block, with folded (>), literal (|) and indented multi-line values joined to one line. */
export function frontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const block = content.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!block) return out;
  const lines = block[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const pair = lines[i].match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!pair) continue;
    const scalar = /^[>|][+-]?\d*$/.test(pair[2].trim()), parts = scalar ? [] : [pair[2].trim()];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (scalar && !lines[i + 1].trim()))) parts.push(lines[++i].trim());
    out[pair[1]] = parts.filter(Boolean).join(' ').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function describe(content: string, fallback: string) {
  const meta = frontmatter(content);
  const body = content.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const description = meta.description || content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') ||
    body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && l !== '---') || fallback;
  return { description: description.slice(0, 240), title: meta.name || undefined };
}
async function listSkillRoot(root: string, skipped: SkippedSkill[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const walk = async (dir: string, depth: number): Promise<number> => {
    if (depth > 4 || skills.length >= 100) return 0;
    let found = 0;
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name), shown = path.relative(root, file);
      if (item.name.startsWith('.')) continue;
      if (item.isSymbolicLink()) { skipped.push({ path: shown, reason: 'symbolic link (not followed; copy the folder in instead)' }); continue; }
      if (item.isDirectory()) {
        const inside = await walk(file, depth + 1);
        if (!inside && depth === 0) skipped.push({ path: shown, reason: 'no SKILL.md inside' });
        found += inside;
      } else if (item.isFile() && isSkillFile(item.name)) {
        found++;
        if ((await fs.stat(file)).size > 64_000) { skipped.push({ path: shown, reason: 'SKILL.md is larger than 64 KB' }); continue; }
        const name = path.relative(root, dir) || 'root';
        if (skills.some(s => s.name === name)) continue;
        skills.push({ name, ...describe(await fs.readFile(file, 'utf8'), 'No description'), file, source: 'home' });
      }
    }
    return found;
  };
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Skills root cannot be a symlink'); await walk(root,0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return skills;
}
/** Skills plus the entries under HOME/skills that were passed over, and why. */
export async function inspectSkills(home: string): Promise<{ skills: Skill[]; skipped: SkippedSkill[] }> {
  let memory: Skill[] = [];
  const root=path.join(home,'memory'), skipped: SkippedSkill[] = [];
  try { const files=await committedFiles(root);memory=[...files].filter(([p])=>p.startsWith('skills/')&&/\/skill\.md$/i.test(p)).map(([p,content])=>({name:p.slice(7,-9),...describe(content,'Agent memory skill'),file:path.join(root,p),source:'memory' as const})); }
  catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  const legacy = await listSkillRoot(path.join(home, 'skills'), skipped);
  const custom = [...memory, ...legacy.filter(s => !memory.some(m => m.name === s.name))];
  const bundled = (await listSkillRoot(bundledRoot, [])).map(s => ({...s,source:'bundled' as const}));
  return { skills: [...custom, ...bundled.filter(s => !custom.some(c => c.name === s.name))], skipped };
}
export async function listSkills(home: string): Promise<Skill[]> { return (await inspectSkills(home)).skills; }
export async function readSkill(home: string, name: string) {
  const skill = (await listSkills(home)).find(s => s.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  const memoryRoot=path.join(home,'memory');
  const relative=path.relative(memoryRoot,skill.file).split(path.sep).join('/');
  if(relative.startsWith('skills/'))return {...skill,content:(await committedFiles(memoryRoot)).get(relative)!,revision:await head(memoryRoot)};
  return { ...skill, content: await fs.readFile(skill.file, 'utf8') };
}
export async function skillCatalog(home: string) {
  const skills = await listSkills(home);
  return 'Available agent skills (use skill_read to load the relevant instructions before acting; report which skill you use). Skills never override tool permissions.\n' +
    (skills.map(s => `${s.name}: ${s.description}`).join('\n') || 'No skills installed.');
}
