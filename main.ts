// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Matching lines (SPEC.md section 5). */
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Positions where O occurs in `file` from `from`, at one tier. */
function occurrences(file: string[], o: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..maxTier) at which O occurs at or after `from`, with its positions. */
function findTier(file: string[], o: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(file, o, from, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: either a context line (the file's own line at `ctx`, an index into O) or a new line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines for a match at `pos`: context lines are the file's own
 * matched lines; at tier 2 the other lines are re-indented (SPEC.md section 5).
 */
function buildN(file: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out = n.map((nl) => (nl.ctx !== null ? file[pos + nl.ctx]! : nl.text));
  if (tier === 2 && o.length > 0) {
    const f = leadWs(file[pos]!);
    const p = leadWs(o[0]!);
    for (let i = 0; i < out.length; i++) {
      if (n[i]!.ctx !== null) continue;
      const line = out[i]!;
      if (line === '' || line.trim() === '') continue;
      if (line.startsWith(p)) out[i] = f + line.slice(p.length);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** The `+` lines of the hunk, in order (for creations). */
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
}

function buildHunk(a: number, body: string[]): Hunk {
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) lastCtxPlus = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const backslashAfterLastCtxPlus =
    lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const backslashAfterLastPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  const o: string[] = [];
  const n: NLine[] = [];
  const plus: string[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l.startsWith(' ') || l === '') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      const t = l.slice(1);
      n.push({ text: t, ctx: null });
      plus.push(t);
    }
  }
  return { a, o, n, plus, backslashAfterLastCtxPlus, backslashAfterLastPlus };
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed, `a/`/`b/` removed. */
function diffPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let headerHasPaths = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerHasPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !headerHasPaths) {
        cur.oldPath = diffPath(line.slice(4));
        cur.newPath = diffPath(lines[i + 1]!.slice(4));
        headerHasPaths = true;
      } else {
        cur = { oldPath: diffPath(line.slice(4)), newPath: diffPath(lines[i + 1]!.slice(4)), isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        headerHasPaths = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      const rf = /^rename from (.*)$/.exec(line);
      const rt = /^rename to (.*)$/.exec(line);
      if (rf !== null) {
        if (!headerHasPaths) cur.oldPath = rf[1]!.trim();
      } else if (rt !== null) {
        if (!headerHasPaths) cur.newPath = rt[1]!.trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply one hunk to a file model; `d` is the section's length delta so far. */
function applyHunk(model: FileModel, hunk: Hunk, d: number, maxTier: number, path: string): FileModel {
  const lines = model.lines;
  if (hunk.o.length === 0) {
    const nLines = hunk.n.map((nl) => nl.text);
    const pos = Math.min(hunk.a + d, lines.length);
    const newLines = [...lines.slice(0, pos), ...nLines, ...lines.slice(pos)];
    let final = model.final;
    if (nLines.length > 0 && pos === lines.length) final = !hunk.backslashAfterLastCtxPlus;
    return { lines: newLines, br: model.br, final };
  }
  const found = findTier(lines, hunk.o, 0, maxTier);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const nLines = buildN(lines, best, hunk.o, hunk.n, found.tier);
  const newLines = [...lines.slice(0, best), ...nLines, ...lines.slice(best + hunk.o.length)];
  let final = model.final;
  if (best + hunk.o.length === lines.length) {
    // The matched lines ran to the end of the file: the result ends with a line
    // break unless a `\` line follows the hunk's last context or `+` line. A
    // hunk of only `-` lines leaves the line before the match last, which ended
    // with a break in the file, so the result ends with one too.
    if (newLines.length === 0) final = false;
    else if (hunkHasCtxOrPlus(hunk)) final = !hunk.backslashAfterLastCtxPlus;
    else final = true;
  }
  return { lines: newLines, br: model.br, final };
}

function hunkHasCtxOrPlus(hunk: Hunk): boolean {
  return hunk.n.some((nl) => nl.ctx !== null) || hunk.plus.length > 0;
}

function applyUniSection(tree: Tree, s: UniSection, maxTier: number): void {
  const oldP = s.oldPath;
  const newP = s.newPath;
  if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  const isCreate = oldP === null || s.isCreate;
  const isDelete = !isCreate && (newP === null || s.isDelete);
  if (isCreate) {
    if (newP === null) return;
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const plus: string[] = [];
    let lastPlusBackslash = false;
    for (const h of s.hunks) {
      if (h.plus.length > 0) lastPlusBackslash = h.backslashAfterLastPlus;
      plus.push(...h.plus);
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n');
    tree.now.set(newP, text);
    return;
  }
  if (isDelete) {
    if (oldP === null) throw new Fail('missing', '');
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, null);
    return;
  }
  // oldP and newP are both non-null here.
  if (oldP === newP) {
    if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
    let model = splitText(tree.get(oldP!)!);
    let d = 0;
    for (const h of s.hunks) {
      model = applyHunk(model, h, d, maxTier, oldP!);
      d += h.n.length - h.o.length;
    }
    tree.now.set(oldP!, joinText(model));
    return;
  }
  if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
  if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
  let model = splitText(tree.get(oldP!)!);
  let d = 0;
  for (const h of s.hunks) {
    model = applyHunk(model, h, d, maxTier, oldP!);
    d += h.n.length - h.o.length;
  }
  tree.now.set(newP!, joinText(model));
  tree.now.set(oldP!, null);
  tree.moves.push([oldP!, newP!]);
}

function uniEdits(lines: string[], maxTier: number): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree) => applyUniSection(tree, s, maxTier));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

function applySRBlock(tree: Tree, b: SRBlock, maxTier: number): void {
  const p = b.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return;
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  const file = splitText(before);
  const found = findTier(file.lines, b.oldLines, 0, maxTier);
  if (found === null) throw new Fail('no-match', p);
  if (found.occ.length > 1) throw new Fail('ambiguous', p);
  const pos = found.occ[0]!;
  const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
  const nLines = buildN(file.lines, pos, b.oldLines, n, found.tier);
  const newLines = [...file.lines.slice(0, pos), ...nLines, ...file.lines.slice(pos + b.oldLines.length)];
  tree.now.set(p, joinText({ lines: newLines, br: file.br, final: file.final }));
}

function srEdits(lines: string[], maxTier: number): Edit[] {
  const blocks = parseSR(lines);
  return blocks.map((b) => (tree: Tree) => applySRBlock(tree, b, maxTier));
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function buildV4AChunk(anchor: string | null, body: string[], eof: boolean): V4AChunk {
  // Blank lines (empty or only whitespace) at the end of a section are not part of it.
  const raw = [...body];
  while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of raw) {
    if (l.startsWith(' ') || l === '') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
  }
  return { anchor, o, n, eof };
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+') || blank(l)) {
          raw.push(l);
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      sections.push({ kind: 'add', path, moveTo: null, addLines: raw.map((l) => (l.startsWith('+') ? l.slice(1) : '')), chunks: [] });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const endChunk = () => {
        if (cur !== null) {
          chunks.push(buildV4AChunk(cur.anchor, cur.body, cur.eof));
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, addLines: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function applyV4ASection(tree: Tree, s: V4ASection, maxTier: number): void {
  const p = s.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
  if (s.kind === 'add') {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'delete') {
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
  let model = splitText(before);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      const found = findTier(model.lines, [chunk.anchor], cursor, maxTier);
      if (found === null) throw new Fail('no-match', p);
      cursor = found.occ[0]! + 1;
    }
    if (chunk.o.length === 0) {
      const nLines = chunk.n.map((nl) => nl.text);
      const pos = chunk.eof ? model.lines.length : cursor;
      const newLines = [...model.lines.slice(0, pos), ...nLines, ...model.lines.slice(pos)];
      model = { lines: newLines, br: model.br, final: model.final };
      cursor = pos + nLines.length;
      continue;
    }
    const found = findTier(model.lines, chunk.o, cursor, maxTier);
    if (found === null) throw new Fail('no-match', p);
    let occ = found.occ;
    if (chunk.eof) {
      occ = occ.filter((pos) => pos + chunk.o.length === model.lines.length);
      if (occ.length === 0) throw new Fail('no-match', p);
    }
    const pos = occ[0]!;
    const nLines = buildN(model.lines, pos, chunk.o, chunk.n, found.tier);
    const newLines = [...model.lines.slice(0, pos), ...nLines, ...model.lines.slice(pos + chunk.o.length)];
    model = { lines: newLines, br: model.br, final: model.final };
    cursor = pos + nLines.length;
  }
  const text = joinText(model);
  if (s.moveTo !== null) {
    tree.now.set(s.moveTo, text);
    tree.now.set(p, null);
    tree.moves.push([p, s.moveTo]);
  } else {
    tree.now.set(p, text);
  }
}

function v4aEdits(lines: string[], maxTier: number): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((s) => (tree: Tree) => applyV4ASection(tree, s, maxTier));
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = uniEdits(lines, maxTier);
    else if (kind === 'search-replace') edits = srEdits(lines, maxTier);
    else edits = v4aEdits(lines, maxTier);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const handled = new Set<string>();
  const rowList: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowList.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      handled.add(oldP);
      handled.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
