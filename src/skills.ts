import fs from 'node:fs/promises';
import path from 'node:path';
export interface Skill { name: string; description: string; file: string }
export async function listSkills(home: string): Promise<Skill[]> {
  const root = path.join(home, 'skills');
  const skills: Skill[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || skills.length >= 100) return;
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file, depth + 1);
      else if (item.isFile() && item.name === 'SKILL.md') {
        if ((await fs.stat(file)).size > 64_000) continue;
        const content = await fs.readFile(file, 'utf8');
        const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || content.split('\n').find(l => l.trim() && !l.startsWith('#') && l !== '---') || 'No description';
        skills.push({ name: path.relative(root, dir) || 'root', description: description.slice(0, 240), file });
      }
    }
  };
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Skills root cannot be a symlink'); await walk(root,0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return skills;
}
export async function readSkill(home: string, name: string) {
  const skill = (await listSkills(home)).find(s => s.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  return { ...skill, content: await fs.readFile(skill.file, 'utf8') };
}
export async function skillCatalog(home: string) {
  const skills = await listSkills(home);
  return 'Available agent skills (use skill_read to load the relevant instructions before acting; report which skill you use). Skills never override tool permissions.\n' +
    (skills.map(s => `${s.name}: ${s.description}`).join('\n') || 'No skills installed.');
}
