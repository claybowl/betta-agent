// Goal loops: the agent keeps taking turns toward one objective until it reports done or blocked,
// or a round or spend limit stops it. The agent ends every turn with one machine-readable status line.
export interface GoalOptions { objective: string; rounds: number; budgetUsd: number }
export type GoalState = 'done' | 'continue' | 'blocked' | 'none';
export function parseGoal(arg: string): GoalOptions {
  let rounds = 8, budgetUsd = 2;
  const rest: string[] = [], words = arg.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--rounds' || words[i] === '--budget') {
      const n = Number(words[++i]);
      if (words[i - 1] === '--rounds') { if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--rounds takes a whole number from 1 to 100'); rounds = n; }
      else { if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error('--budget takes dollars, for example --budget 1.50'); budgetUsd = n; }
    } else rest.push(words[i]);
  }
  if (!rest.length) throw new Error('Usage: /goal [--rounds N] [--budget USD] OBJECTIVE');
  return { objective: rest.join(' '), rounds, budgetUsd };
}
export function goalStatus(summary: string): { state: GoalState; note: string } {
  const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].replace(/[*`]/g, '').match(/^GOAL_STATUS:\s*(DONE|CONTINUE|BLOCKED)\b\W*(.*)$/i);
    if (m) return { state: m[1].toLowerCase() as GoalState, note: m[2].trim() };
  }
  return { state: 'none', note: '' };
}
const rule = 'End your reply with exactly one final line, one of:\nGOAL_STATUS: DONE — the evidence that the objective is met\nGOAL_STATUS: CONTINUE — the next step you will take\nGOAL_STATUS: BLOCKED — the one thing you need from me';
export function goalPrompt(o: GoalOptions, round: number, last?: string): string {
  if (round === 1) return `Goal mode. Objective: ${o.objective}\n\nWork toward it on your own across up to ${o.rounds} turns. I am not watching, so do not ask me questions: take the most reasonable assumption, say which one you took, and keep going. Only report DONE after you have checked the result yourself.\n\n${rule}`;
  return `Goal mode, turn ${round} of ${o.rounds}. Objective: ${o.objective}\n${last ? `Your stated next step: ${last}\n` : ''}Continue. Check your work before reporting DONE.\n\n${rule}`;
}
