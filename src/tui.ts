// Terminal interface kit: themes, a line editor with a slash-command palette, a filterable picker and a spinner.
// Everything here draws only on an interactive terminal; scripted (piped) chat never reaches these functions.
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

export const clean = (value: unknown) => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const chars = (s: string) => [...s];
export const width = (s: string) => chars(stripVTControlCharacters(s)).length;
export const clip = (s: string, max: number) => { const c = chars(s); return c.length <= max ? s : max < 1 ? '' : c.slice(0, max - 1).join('') + '…'; };
export const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)));
const columns = () => Math.max(24, process.stdout.columns || 80);

// ── Themes ────────────────────────────────────────────────────────────────────────────────────────────────────
export type ThemeName = 'magic' | 'purple' | 'plain';
export const themeNames: ThemeName[] = ['magic', 'purple', 'plain'];
export const themeLabels: Record<ThemeName, string> = { magic: 'Magic City — gold, flamingo, teal', purple: 'Donjon purple', plain: 'Plain — no colors' };
type Tone = [number, number, number, number]; // r, g, b, 256-color fallback
type ToneName = 'accent' | 'second' | 'third' | 'dim' | 'ok' | 'warn' | 'err';
const palettes: Record<Exclude<ThemeName, 'plain'>, Record<ToneName, Tone>> = {
  magic: { accent: [232, 184, 92, 179], second: [64, 200, 190, 44], third: [255, 122, 150, 211], dim: [140, 134, 122, 245], ok: [126, 200, 140, 114], warn: [240, 160, 80, 215], err: [240, 110, 110, 203] },
  purple: { accent: [135, 95, 255, 99], second: [175, 135, 255, 141], third: [215, 175, 255, 183], dim: [138, 138, 138, 245], ok: [135, 175, 135, 108], warn: [215, 175, 95, 179], err: [215, 135, 135, 174] },
};
type Paint = (text: unknown) => string;
export interface Theme extends Record<ToneName, Paint> { name: ThemeName; strong: Paint; gradient(lines: string[]): string[] }
export function makeTheme(name: ThemeName, enabled: boolean): Theme {
  const on = enabled && name !== 'plain', palette = palettes[name === 'plain' ? 'magic' : name];
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');
  const code = (t: Tone) => truecolor ? `38;2;${t[0]};${t[1]};${t[2]}` : `38;5;${t[3]}`;
  const paint = (t: Tone, bold = false): Paint => value => { const text = clean(value); return on && text ? `\x1b[${bold ? '1;' : ''}${code(t)}m${text}\x1b[0m` : text; };
  const stops = [palette.accent, palette.third, palette.second];
  return {
    name, strong: paint(palette.accent, true),
    accent: paint(palette.accent), second: paint(palette.second), third: paint(palette.third), dim: paint(palette.dim),
    ok: paint(palette.ok), warn: paint(palette.warn), err: paint(palette.err),
    gradient: lines => lines.map((text, i) => {
      const at = lines.length > 1 ? (i / (lines.length - 1)) * (stops.length - 1) : 0, a = stops[Math.floor(at)], b = stops[Math.ceil(at)], f = at - Math.floor(at);
      return paint(truecolor ? [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f)).concat(0) as Tone : stops[Math.round(at)], true)(text);
    }),
  };
}
export const rule = (theme: Theme, title: string, cols = columns()) => {
  const w = Math.min(cols - 1, 92), shown = clip(clean(title), Math.max(4, w - 10));
  return theme.accent('◆━━ ') + theme.strong(shown) + theme.accent(' ' + '━'.repeat(Math.max(1, w - width(shown) - 6)) + '◆');
};
const wordmark = [
  '██████╗ ███████╗████████╗████████╗ █████╗ ',
  '██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔══██╗',
  '██████╔╝█████╗     ██║      ██║   ███████║',
  '██╔══██╗██╔══╝     ██║      ██║   ██╔══██║',
  '██████╔╝███████╗   ██║      ██║   ██║  ██║',
  '╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝',
];
// The large wordmark is drawn from a heavy, wide pixel face: 10 pixels tall, two pixels per text row (half blocks).
const face: Record<string, string[]> = {
  B: ['########..', '#########.', '###...####', '###...###.', '########..', '#########.', '###...####', '###...####', '#########.', '########..'],
  E: ['#########', '#########', '###......', '###......', '########.', '########.', '###......', '###......', '#########', '#########'],
  T: ['##########', '##########', '...####...', '...####...', '...####...', '...####...', '...####...', '...####...', '...####...', '...####...'],
  A: ['....###....', '...#####...', '...#####...', '..###.###..', '..###.###..', '.###...###.', '.#########.', '###########', '###.....###', '###.....###'],
  G: ['.########.', '##########', '###....###', '###.......', '###..#####', '###..#####', '###....###', '###....###', '##########', '.########.'],
  N: ['###....###', '####...###', '#####..###', '######.###', '##########', '##########', '###.######', '###..#####', '###...####', '###....###'],
  S: ['.########.', '##########', '###....###', '####......', '.#######..', '..#######.', '......####', '###....###', '##########', '.########.'],
};
function bigWord(word: string): string[] {
  const rows = Array.from({ length: 10 }, (_, r) => [...word].map(c => face[c][r]).join('..'));
  return Array.from({ length: 5 }, (_, r) => [...rows[r * 2]].map((top, x) => { const low = rows[r * 2 + 1][x] === '#'; return top === '#' ? (low ? '█' : '▀') : low ? '▄' : ' '; }).join(''));
}
const bigMark = [...bigWord('BETTA'), '', ...bigWord('AGENTS')], bigW = Math.max(...bigMark.map(l => l.length));
interface BannerParts { head: string[]; mark: string[]; tail: string[] }
function bannerParts(theme: Theme, cols: number): BannerParts {
  if (cols >= bigW + 4) {
    const bar = '◆' + '━'.repeat(Math.floor((bigW - 3) / 2)) + '◇' + '━'.repeat(bigW - 3 - Math.floor((bigW - 3) / 2)) + '◆';
    return { head: ['', theme.second('  D O N J O N . A G E N C Y   ·   D O E R . C O M P A N Y'), theme.accent('  ' + bar), ''], mark: bigMark.map(l => '  ' + l),
      tail: ['', theme.accent('  ' + bar), theme.third('  Small fish. Long memory.'), ''] };
  }
  const w = 42, centre = (s: string) => ' '.repeat(Math.max(0, Math.floor((w - width(s)) / 2))) + s;
  const framed = (middle: string, glyph: string) => { const n = w - width(middle) - 4, left = Math.floor(n / 2); return '◆' + '━'.repeat(left) + glyph + middle + glyph + '━'.repeat(n - left) + '◆'; };
  if (cols < w + 4) return { head: ['', theme.strong('◆ B E T T A   A G E N T S ◆'), theme.dim('donjon.agency · doer.company'), ''], mark: [], tail: [] };
  return { head: ['', theme.accent('  ◆' + '━'.repeat(19) + '◇' + '━'.repeat(20) + '◆')], mark: wordmark.map(l => '  ' + l),
    tail: [theme.accent('  ' + framed('  A G E N T S  ', '◇')), theme.third('  ' + centre('Small fish. Long memory.')), theme.dim('  ' + centre('donjon.agency  ·  doer.company')), ''] };
}
export function banner(theme: Theme, cols = columns()): string {
  const p = bannerParts(theme, cols);
  return [...p.head, ...theme.gradient(p.mark), ...p.tail].join('\n');
}
/** Startup reveal: a slanted wipe draws the wordmark behind a bright leading edge, then one glint crosses it. Ends on exactly banner(). */
export async function playBanner(theme: Theme, cols = columns(), out: NodeJS.WriteStream = process.stdout): Promise<void> {
  const p = bannerParts(theme, cols), still = banner(theme, cols);
  if (!out.isTTY || theme.name === 'plain' || !p.mark.length || process.env.NO_COLOR || process.env.DONJON_NO_MOTION || theme.accent('x') === 'x') { out.write(still + '\n'); return; }
  const mark = p.mark.map(l => [...l]), w = Math.max(...mark.map(l => l.length)), rows = p.head.length + mark.length + p.tail.length, slant = 2;
  const glint = (s: string) => s.trim() ? `\x1b[1;97m${s}\x1b[0m` : s, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const frame = (lines: string[], first: boolean) => out.write((first ? '' : `\x1b[${rows}A`) + lines.map(l => '\x1b[2K' + l).join('\n') + '\n');
  const blank = (list: string[]) => list.map(() => '');
  out.write('\x1b[?25l');
  try {
    // Wipe: each row lags the one above it, so the edge leans like a deco chevron.
    const span = w + mark.length * slant + 6, steps = 34;
    for (let n = 0; n <= steps; n++) {
      const t = n / steps, front = Math.round((1 - Math.pow(1 - t, 3)) * span);
      const body = mark.map((_, r) => front - r * slant - 4), lit = theme.gradient(mark.map((l, r) => l.slice(0, Math.max(0, body[r])).join('')));
      const lines = mark.map((l, r) => lit[r] + glint(l.slice(Math.max(0, body[r]), Math.max(0, body[r] + 4)).join('')));
      const shown = t > 0.25;
      frame([...(shown ? p.head : blank(p.head)), ...lines, ...blank(p.tail)], n === 0); await sleep(16);
    }
    // Glint: one narrow highlight runs back across the finished letters.
    const pass = 22;
    for (let n = 0; n <= pass; n++) {
      const at = Math.round((n / pass) * (w + mark.length * slant + 8)) - 4;
      const a = theme.gradient(mark.map((l, r) => l.slice(0, Math.max(0, at - r * slant)).join(''))), c = theme.gradient(mark.map((l, r) => l.slice(Math.max(0, at - r * slant + 3)).join('')));
      const lines = mark.map((l, r) => a[r] + glint(l.slice(Math.max(0, at - r * slant), Math.max(0, at - r * slant + 3)).join('')) + c[r]);
      frame([...p.head, ...lines, ...(n > pass / 2 ? p.tail : blank(p.tail))], false); await sleep(14);
    }
    out.write(`\x1b[${rows}A` + still.split('\n').map(l => '\x1b[2K' + l).join('\n') + '\n');
  } finally { out.write('\x1b[?25h'); }
}

// ── Keyboard and drawing ──────────────────────────────────────────────────────────────────────────────────────
interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
const printable = (text: string | undefined, key: Key) => Boolean(text) && !key.ctrl && !key.meta && chars(text!).every(c => c >= ' ' && c !== '\x7f');
function keys<T>(onKey: (text: string | undefined, key: Key, finish: (value: T) => void) => void, cancel?: { signal?: AbortSignal; value: T; cleanup?: () => void }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (cancel?.signal) { if (cancel.signal.aborted) return resolve(cancel.value); cancel.signal.addEventListener('abort', () => { if (!settled) { cancel.cleanup?.(); finish(cancel.value); } }, { once: true }); }
    const stdin = process.stdin, wasRaw = stdin.isRaw;
    let settled = false;
    const release = () => { settled = true; stdin.off('keypress', listener); stdin.setRawMode(wasRaw || false); stdin.pause(); };
    const finish = (value: T) => { if (!settled) { release(); resolve(value); } };
    const listener = (text: string | undefined, key: Key | undefined) => {
      if (settled) return;
      try { onKey(text, key || {}, finish); } catch (error) { release(); reject(error); }
    };
    emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.on('keypress', listener); stdin.resume();
  });
}
// A block of lines redrawn in place. Lines are pre-fitted to the terminal width so it never wraps on its own.
class Region {
  private row = 0;
  draw(lines: string[], cursorRow: number, cursorCol: number) {
    const up = lines.length - 1 - cursorRow;
    process.stdout.write('\x1b[?25l' + (this.row ? `\x1b[${this.row}A` : '') + '\r\x1b[J' + lines.join('\r\n') +
      (up > 0 ? `\x1b[${up}A` : '') + '\r' + (cursorCol ? `\x1b[${cursorCol}C` : '') + '\x1b[?25h');
    this.row = cursorRow;
  }
  clear() { process.stdout.write((this.row ? `\x1b[${this.row}A` : '') + '\r\x1b[J'); this.row = 0; }
}
const windowed = (count: number, selected: number, size: number) => Math.max(0, Math.min(selected - Math.floor(size / 2), count - size));

// ── Line editor with slash-command palette ────────────────────────────────────────────────────────────────────
export interface Command { name: string; description: string }
export function matchCommands(commands: Command[], typed: string): Command[] {
  const q = typed.toLowerCase();
  if (!q.startsWith('/') || /\s/.test(q)) return [];
  const prefix = commands.filter(c => c.name.startsWith(q));
  if (prefix.length) return prefix;
  const inner = commands.filter(c => c.name.includes(q.slice(1)));
  return inner.length ? inner : commands.filter(c => c.description.toLowerCase().includes(q.slice(1)));
}
export interface LineOptions { label: string; theme: Theme; history?: string[]; commands?: Command[]; hint?: string; /** Show bullets instead of the typed text. */ mask?: boolean; /** Aborting ends the prompt with null. */ signal?: AbortSignal }
/** Resolves with the entered line, or null when the user leaves with Ctrl-C / Ctrl-D on an empty line. */
export function readLine(o: LineOptions): Promise<string | null> {
  const { theme } = o, label = clean(o.label), labelW = width(label), region = new Region(), history = o.history || [];
  let buf: string[] = [], pos = 0, selected = 0, dismissed = false, past = -1, draft = '';
  const text = () => buf.join('');
  const menu = () => dismissed || !o.commands ? [] : matchCommands(o.commands, text());
  const set = (value: string) => { buf = chars(value); pos = buf.length; };
  const edited = () => { selected = 0; dismissed = false; past = -1; };
  const draw = (final = false) => {
    const w = columns() - 1, cells = [...' '.repeat(labelW), ...(o.mask ? buf.map(() => '•') : buf)], lines: string[] = [];
    for (let i = 0; i * w < cells.length + 1; i++) lines.push(cells.slice(i * w, (i + 1) * w).join(''));
    lines[0] = theme.strong(label) + lines[0].slice(labelW);
    if (final) { region.draw(lines, lines.length - 1, 0); process.stdout.write('\r\n'); return; }
    const items = menu(), inputRows = lines.length;
    if (items.length) {
      const size = Math.min(8, Math.max(3, (process.stdout.rows || 24) - inputRows - 3)), top = windowed(items.length, selected, size);
      const nameW = Math.max(...items.map(c => width(c.name)));
      items.slice(top, top + size).forEach((c, i) => {
        const on = top + i === selected, left = `  ${on ? '▸' : ' '} ${pad(c.name, nameW)}  `, rest = clip(c.description, w - width(left));
        lines.push(on ? theme.strong(left + rest) : theme.second(left) + theme.dim(rest));
      });
      lines.push(theme.dim(clip(`  ↑↓ select · Tab complete · Enter run · Esc close${items.length > size ? ` · ${selected + 1}/${items.length}` : ''}`, w)));
    } else if (!buf.length && o.hint) lines.push(theme.dim(clip('  ' + o.hint, w)));
    const at = labelW + pos;
    region.draw(lines, Math.floor(at / w), at % w);
  };
  draw();
  return keys<string | null>((typed, key, finish) => {
    const items = menu(), name = key.name;
    if (name === 'return' || name === 'enter') {
      if (items.length) set(items[Math.min(selected, items.length - 1)].name);
      draw(true); return finish(text());
    }
    if (key.ctrl && name === 'c') { if (buf.length) { set(''); edited(); } else { draw(true); return finish(null); } }
    else if (key.ctrl && name === 'd') { if (!buf.length) { draw(true); return finish(null); } buf.splice(pos, 1); edited(); }
    else if (name === 'tab') { if (items.length) { set(items[Math.min(selected, items.length - 1)].name + ' '); edited(); } }
    else if (name === 'escape') { if (items.length) dismissed = true; }
    else if (name === 'up' || name === 'down') {
      const step = name === 'up' ? -1 : 1;
      if (items.length) selected = (Math.min(selected, items.length - 1) + step + items.length) % items.length;
      else if (history.length) {
        if (past < 0) draft = text();
        past = Math.max(-1, Math.min(history.length - 1, past - step));
        set(past < 0 ? draft : history[past]);
      }
    }
    else if (name === 'left' || (key.ctrl && name === 'b')) pos = Math.max(0, pos - 1);
    else if (name === 'right' || (key.ctrl && name === 'f')) pos = Math.min(buf.length, pos + 1);
    else if (name === 'home' || (key.ctrl && name === 'a')) pos = 0;
    else if (name === 'end' || (key.ctrl && name === 'e')) pos = buf.length;
    else if (name === 'backspace') { if (pos) { buf.splice(--pos, 1); edited(); } }
    else if (name === 'delete') { buf.splice(pos, 1); edited(); }
    else if (key.ctrl && name === 'u') { buf.splice(0, pos); pos = 0; edited(); }
    else if (key.ctrl && name === 'k') { buf.splice(pos); edited(); }
    else if (key.ctrl && name === 'w') { let start = pos; while (start && buf[start - 1] === ' ') start--; while (start && buf[start - 1] !== ' ') start--; buf.splice(start, pos - start); pos = start; edited(); }
    else if (printable(typed, key)) { const added = chars(typed!); buf.splice(pos, 0, ...added); pos += added.length; edited(); }
    else return;
    draw();
  }, { signal: o.signal, value: null, cleanup: () => draw(true) });
}

// ── Picker ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PickItem<T> {
  label: string; value: T; detail?: string; badge?: string; tone?: 'ok' | 'warn' | 'dim' | 'second' | 'third';
  /** Marks the entry currently in effect; the picker opens on it. */ current?: boolean;
  /** Still selectable, but drawn muted. */ muted?: boolean;
  /** Reason shown instead of selecting. */ disabled?: string;
}
export interface PickApi<T> { set(items: PickItem<T>[]): void; status(text: string, busy?: boolean): void; signal: AbortSignal }
export interface PickOptions<T> {
  title: string; theme: Theme; items?: PickItem<T>[]; hint?: string; status?: string; select?: T; filter?: boolean; receipt?: boolean;
  /** Called once the picker is on screen; use it to stream entries in as they arrive. */
  load?: (api: PickApi<T>) => unknown;
}
export function filterItems<T>(items: PickItem<T>[], query: string): PickItem<T>[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  const scored: [number, number, PickItem<T>][] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase(), rest = `${item.detail || ''} ${item.badge || ''}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      const at = label.indexOf(t);
      if (at === 0) score += 0; else if (at > 0) score += /[^a-z0-9]/.test(label[at - 1]) ? 1 : 2; else if (rest.includes(t)) score += 4; else return;
    }
    scored.push([score, index, item]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(s => s[2]);
}
/** Resolves with the chosen entry, or undefined when the user backs out with Esc. */
export function pick<T>(o: PickOptions<T>): Promise<PickItem<T> | undefined> {
  const { theme } = o, region = new Region(), abort = new AbortController(), frames = ['◇', '◈', '◆', '◈'];
  let all = o.items || [], query: string[] = [], selected = 0, moved = false, status = o.status || '', busy = false, frame = 0, note = '', closed = false;
  let want: T | undefined = o.select;
  const shown = () => o.filter === false ? all : filterItems(all, query.join(''));
  const settle = () => {
    const list = shown();
    let index = moved || want !== undefined ? list.findIndex(i => i.value === want) : query.length ? 0 : list.findIndex(i => i.current);
    if (index < 0) index = moved ? Math.min(selected, list.length - 1) : 0;
    selected = Math.max(0, index);
  };
  const draw = () => {
    if (closed) return;
    const w = columns() - 1, list = shown(), size = Math.max(3, Math.min(12, (process.stdout.rows || 24) - 7)), top = windowed(list.length, selected, size);
    const view = list.slice(top, top + size), labelW = Math.min(Math.max(8, ...view.map(i => width(i.label))), Math.max(12, Math.floor(w * 0.5)));
    const search = o.filter === false ? '' : '  ⌕ ' + query.join('');
    const lines = [rule(theme, o.title)];
    if (o.filter !== false) lines.push(theme.second('  ⌕ ') + clip(query.join(''), w - 5));
    const count = all.length ? `${list.length}${list.length === all.length ? '' : '/' + all.length}` : '';
    const info = [busy ? frames[frame % frames.length] : '', note || status, count && (query.length || all.length > size) ? count : ''].filter(Boolean).join('  ');
    if (info) lines.push(note ? theme.warn(clip('  ' + info, w)) : theme.dim(clip('  ' + info, w)));
    if (!list.length) lines.push(theme.dim(all.length ? '  No matches.' : busy ? '  Loading…' : '  Nothing to show.'));
    let cursorRow = 1;
    view.forEach((item, i) => {
      const on = top + i === selected, label = pad(clip(item.label, labelW), labelW);
      if (on) cursorRow = lines.length;
      let line = on ? theme.strong(`  ▸ ${label}`) : item.disabled || item.muted ? theme.dim(`    ${label}`) : `    ${label}`, used = 4 + labelW;
      if (item.badge && w - used > 6) { const badge = clip(item.badge, w - used - 2); line += '  ' + theme[item.disabled ? 'dim' : item.tone || 'second'](badge); used += 2 + width(badge); }
      if (item.detail && w - used > 8) line += '  ' + theme.dim(clip(item.detail, w - used - 2));
      lines.push(line);
    });
    lines.push(theme.dim(clip('  ' + (o.hint || `↑↓ move${o.filter === false ? '' : ' · type to filter'} · Enter select · Esc back`), w)));
    region.draw(lines, o.filter === false ? cursorRow : 1, o.filter === false ? 2 : Math.min(width(search), w));
  };
  settle(); draw();
  const timer = setInterval(() => { if (busy) { frame++; draw(); } }, 140);
  const api: PickApi<T> = {
    signal: abort.signal,
    set(items) { if (closed) return; const list = shown(); if (moved) want = list[selected]?.value; all = items; settle(); draw(); },
    status(textValue, isBusy = false) { if (closed) return; status = clean(textValue); busy = isBusy; draw(); },
  };
  if (o.load) Promise.resolve().then(() => o.load!(api)).catch(error => api.status(error instanceof Error ? error.message : String(error)));
  return keys<PickItem<T> | undefined>((typed, key, finish) => {
    const list = shown(), name = key.name, close = (value: PickItem<T> | undefined) => {
      closed = true; clearInterval(timer); abort.abort(); region.clear();
      if (value && o.receipt !== false) process.stdout.write(theme.accent('◆ ') + theme.dim(clean(o.title) + ' › ') + theme.strong(value.label) + '\r\n');
      finish(value);
    };
    const move = (to: number) => { if (list.length) { selected = (to + list.length) % list.length; moved = true; want = list[selected].value; } };
    note = '';
    if (name === 'escape' || (key.ctrl && (name === 'c' || name === 'd'))) return close(undefined);
    if (name === 'return' || name === 'enter') { const item = list[selected]; if (!item) return; if (item.disabled) { note = item.disabled; return draw(); } return close(item); }
    if (name === 'up') move(selected - 1); else if (name === 'down' || name === 'tab') move(selected + 1);
    else if (name === 'pageup') move(Math.max(0, selected - 10)); else if (name === 'pagedown') move(Math.min(list.length - 1, selected + 10));
    else if (name === 'home') move(0); else if (name === 'end') move(list.length - 1);
    else if (o.filter === false) return;
    else if (name === 'backspace') { query.pop(); moved = false; want = undefined; settle(); }
    else if (key.ctrl && name === 'u') { query = []; moved = false; want = undefined; settle(); }
    else if (printable(typed, key)) { query.push(...chars(typed!)); moved = false; want = undefined; selected = 0; }
    else return;
    draw();
  });
}

// ── Spinner ───────────────────────────────────────────────────────────────────────────────────────────────────
export function spinner(theme: Theme, text: () => string) {
  const frames = ['◇', '◈', '◆', '◈'], live = Boolean(process.stdout.isTTY);
  let frame = 0, shown = false, paused = false, timer: NodeJS.Timeout | undefined;
  const hide = () => { if (shown) { process.stdout.write('\r\x1b[2K'); shown = false; } };
  const draw = () => { if (paused) return; process.stdout.write('\r\x1b[2K' + theme.accent(frames[frame++ % frames.length]) + ' ' + theme.dim(clip(text(), columns() - 4))); shown = true; };
  return {
    start() { if (live && !timer) { draw(); timer = setInterval(draw, 160); } },
    /** Clear the spinner line before printing something else; it redraws on its next tick. */ hide,
    pause() { hide(); paused = true; }, resume() { paused = false; },
    stop() { if (timer) clearInterval(timer); timer = undefined; hide(); },
  };
}

/** Tool output as a short readable preview: JSON is unwrapped and pretty-printed, strings show their real line breaks. The model still receives the full output. */
export function toolPreview(text: string, maxLines = 12) {
  let shown = text;
  try {
    const value = JSON.parse(text);
    const inner = value?.data?.content ?? value?.content;
    shown = typeof inner === 'string' ? inner : JSON.stringify(value, null, 2);
  } catch { /* plain text */ }
  const lines = clean(shown).split('\n').map(l => l.length > 160 ? l.slice(0, 159) + '…' : l);
  const more = lines.length - maxLines;
  return '  ' + lines.slice(0, maxLines).join('\n  ') + (more > 0 ? `\n  … ${more} more lines shown to the agent, not here` : '');
}
