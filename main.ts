// mend: one patch tool for every AI edit format.
// Node 22, standard library only. The whole contract is SPEC.md:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none.
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}

function trimEndWs(s: string): string {
  return s.replace(/\s+$/, "");
}

// Trim spaces and tabs from both ends (used for paths and anchors).
function trimST(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function trimEndST(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function leadingST(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

class ParseErr extends Error {
  n: number;
  constructor(n: number) {
    super("parse " + n);
    this.n = n;
  }
}

// A path is safe when it is not empty, does not start with `/`, holds no
// `\`, and none of its `/`-separated segments is empty, `.` or `..`.
function isSafe(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File model: lines, line break, final line break (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === "") return { lines: [], br: "\n", finalBreak: false };
  const firstLf = text.indexOf("\n");
  const br = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, br, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return "";
  return m.lines.join(m.br) + (m.finalBreak ? m.br : "");
}

// A patch's lines: text split at `\n`, one trailing `\r` removed per line,
// without the empty piece after a final `\n`.
function splitPatch(text: string): string[] {
  const raw = text.split("\n");
  if (text.endsWith("\n")) raw.pop();
  return raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// `new_str` lines for JSON insert: same splitting, empty string has none.
function splitNewStr(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (s.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Line matching at three tiers (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function findOcc(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(
  lines: string[],
  o: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOcc(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One replacement block: O lines replaced by N lines. ctxN[j] marks the
// lines of N that are context lines; ctxOMap[j] is their index in O.
interface Block {
  o: string[];
  n: string[];
  ctxN: boolean[];
  ctxOMap: number[];
}

function replaceAt(lines: string[], at: number, block: Block, tier: number): string[] {
  const f = lines.length > 0 && at < lines.length ? leadingST(lines[at]) : "";
  const p = block.o.length > 0 ? leadingST(block.o[0]) : "";
  const out: string[] = lines.slice(0, at);
  for (let j = 0; j < block.n.length; j++) {
    if (block.ctxN[j]) {
      // A context line is written as the file's own matched line.
      out.push(lines[at + block.ctxOMap[j]]);
      continue;
    }
    let s = block.n[j];
    if (tier === 2 && s !== "" && !/^[ \t]*$/.test(s) && s.startsWith(p)) {
      s = f + s.slice(p.length);
    }
    out.push(s);
  }
  return out.concat(lines.slice(at + block.o.length));
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface Change {
  path: string;
  content: string | null; // null deletes the file
}

interface EditResult {
  ok: boolean;
  code?: string;
  path?: string;
  changes?: Change[];
  move?: { old: string; nw: string };
}

interface Edit {
  paths: string[]; // every path the edit names, old before new
  run: (tree: Map<string, string>) => EditResult;
}

// ---------------------------------------------------------------------------
// Command line (SPEC section 1)
// ---------------------------------------------------------------------------

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseCli(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let afterDD = false;
  for (const a of argv) {
    if (!afterDD) {
      if (a === "--") {
        afterDD = true;
        continue;
      }
      if (a === "--check") {
        if (check) return null;
        check = true;
        continue;
      }
      if (a === "--strict") {
        if (strict) return null;
        strict = true;
        continue;
      }
      if (a.startsWith("--format=")) {
        if (format !== null) return null;
        const v = a.slice("--format=".length);
        if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") return null;
        format = v;
        continue;
      }
      if (a.startsWith("-") && a !== "-") return null;
      if (patch !== null) return null;
      patch = a;
      continue;
    }
    if (patch !== null) return null;
    patch = a;
  }
  return { format: format ?? "auto", check, strict, patch };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank === null) return null;
  if (firstNonBlank.trim() === "*** Begin Patch") return "v4a";
  const firstCh = firstNonBlank.trimStart()[0];
  if (firstCh === "[" || firstCh === "{") return "json";
  for (const l of lines) {
    if (trimEndWs(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) return "unified";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree IO
// ---------------------------------------------------------------------------

function loadTree(root: string): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
    for (const e of entries) {
      const p = rel === "" ? e.name : rel + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, p);
      else if (e.isFile()) {
        try {
          tree.set(p, fs.readFileSync(full, "utf8"));
        } catch {
          // An unreadable file is left out of the tree.
        }
      }
    }
  };
  walk(root, "");
  return tree;
}

function writeTree(root: string, before: Map<string, string>, after: Map<string, string>): void {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  for (const p of sorted) {
    const b = before.get(p);
    const a = after.get(p);
    if (a === b) continue;
    const full = path.join(root, p);
    if (a === undefined) {
      try {
        fs.unlinkSync(full);
      } catch {
        // Already gone.
      }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, a, "utf8");
    }
  }
}

// Success output (SPEC section 2): one line per changed path in byte
// order, then `ok: <n> files`.
function computeOutput(
  before: Map<string, string>,
  after: Map<string, string>,
  moves: Array<{ old: string; nw: string }>,
): string[] {
  const items: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const m of moves) {
    if (before.has(m.old) && !after.has(m.old) && !before.has(m.nw) && after.has(m.nw)) {
      items.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      usedOld.add(m.old);
      usedNew.add(m.nw);
    }
  }
  const all = new Set<string>([...before.keys(), ...after.keys()]);
  for (const p of all) {
    const b = before.get(p);
    const a = after.get(p);
    if (a === b) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    if (b === undefined) items.push({ key: p, text: `A ${p}` });
    else if (a === undefined) items.push({ key: p, text: `D ${p}` });
    else items.push({ key: p, text: `M ${p}` });
  }
  items.sort((x, y) => Buffer.compare(Buffer.from(x.key, "utf8"), Buffer.from(y.key, "utf8")));
  const lines = items.map((it) => it.text);
  lines.push(items.length === 1 ? "ok: 1 file" : `ok: ${items.length} files`);
  return lines;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctxN: boolean[];
  ctxOMap: number[];
  noNL: boolean; // a `\` line follows the hunk's last context or `+` line
  lastPlusNoNL: boolean | null; // a `\` line follows the hunk's last `+` line
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  let j = start;
  const items: Array<{ kind: string; text: string; raw: string }> = [];
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith("diff --git ")) break;
    if (l.startsWith("--- ") && j + 1 < lines.length && lines[j + 1].startsWith("+++ ")) break;
    if (l.startsWith("@@")) break;
    if (l === "") {
      items.push({ kind: "ctx", text: "", raw: l });
      j++;
    } else if (l.startsWith(" ")) {
      items.push({ kind: "ctx", text: l.slice(1), raw: l });
      j++;
    } else if (l.startsWith("-")) {
      items.push({ kind: "old", text: l.slice(1), raw: l });
      j++;
    } else if (l.startsWith("+")) {
      items.push({ kind: "new", text: l.slice(1), raw: l });
      j++;
    } else if (l.startsWith("\\")) {
      items.push({ kind: "bs", text: l.slice(1), raw: l });
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0 && items[items.length - 1].raw === "") items.pop();
  const o: string[] = [];
  const n: string[] = [];
  const ctxN: boolean[] = [];
  const ctxOMap: number[] = [];
  for (const it of items) {
    if (it.kind === "ctx") {
      ctxOMap.push(o.length);
      o.push(it.text);
      ctxN.push(true);
      n.push(it.text);
    } else if (it.kind === "old") {
      o.push(it.text);
    } else if (it.kind === "new") {
      ctxN.push(false);
      ctxOMap.push(-1);
      n.push(it.text);
    }
  }
  let lastCN = -1;
  let lastPlus = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k].kind === "ctx" || items[k].kind === "new") lastCN = k;
    if (items[k].kind === "new") lastPlus = k;
  }
  const noNL = lastCN >= 0 && lastCN + 1 < items.length && items[lastCN + 1].kind === "bs";
  const lastPlusNoNL =
    lastPlus >= 0 ? lastPlus + 1 < items.length && items[lastPlus + 1].kind === "bs" : null;
  return { hunk: { a, o, n, ctxN, ctxOMap, noNL, lastPlusNoNL }, next: j };
}

// Apply a section's hunks in order to a file's text.
function applyHunks(
  text: string,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; content: string } | { ok: false } {
  const m = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = firstTier(m.lines, h.o, strict);
      if (!found) return { ok: false };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + h.o.length === m.lines.length;
      const block: Block = { o: h.o, n: h.n, ctxN: h.ctxN, ctxOMap: h.ctxOMap };
      m.lines = replaceAt(m.lines, best, block, found.tier);
      if (touchesEnd) m.finalBreak = !h.noNL;
      d += h.n.length - h.o.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > m.lines.length) pos = m.lines.length;
      const atEnd = pos === m.lines.length;
      m.lines = [...m.lines.slice(0, pos), ...h.n, ...m.lines.slice(pos)];
      if (atEnd) m.finalBreak = !h.noNL;
      d += h.n.length;
    }
  }
  return { ok: true, content: renderFile(m) };
}

interface SecBuild {
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): SecBuild {
  return {
    diffOld: null,
    diffNew: null,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

// The path after `--- ` / `+++ `: text after the four characters, up to
// the first tab, with surrounding spaces removed, one leading `a/` or
// `b/` removed.
function parseDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf("\t");
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  if (rest.startsWith("a/")) rest = rest.slice(2);
  else if (rest.startsWith("b/")) rest = rest.slice(2);
  return rest;
}

function parseDiffGit(line: string): { x: string; y: string } | null {
  const rest = line.slice("diff --git ".length).trim();
  const parts = rest.split(/\s+/);
  if (parts.length !== 2) return null;
  if (!parts[0].startsWith("a/") || !parts[1].startsWith("b/")) return null;
  return { x: parts[0].slice(2), y: parts[1].slice(2) };
}

function unifiedSectionToEdit(sec: SecBuild, strict: boolean): Edit {
  const oldPath = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  // Creation: old path `/dev/null`, or `new file mode`.
  if (sec.newFile || oldPath === null) {
    const p = newPath ?? "/dev/null";
    return {
      paths: [p],
      run: (tree) => {
        if (tree.has(p)) return { ok: false, code: "exists", path: p };
        const plus: string[] = [];
        let noNL = false;
        for (const h of sec.hunks) {
          for (let j = 0; j < h.n.length; j++) {
            if (!h.ctxN[j]) plus.push(h.n[j]);
          }
          if (h.lastPlusNoNL !== null) noNL = h.lastPlusNoNL;
        }
        const content = plus.length === 0 ? "" : plus.join("\n") + (noNL ? "" : "\n");
        return { ok: true, changes: [{ path: p, content }] };
      },
    };
  }
  // Deletion: new path `/dev/null`, or `deleted file mode`. Hunks not read.
  if (sec.deletedFile || newPath === null) {
    const p = oldPath ?? "/dev/null";
    return {
      paths: [p],
      run: (tree) =>
        !tree.has(p)
          ? { ok: false, code: "missing", path: p }
          : { ok: true, changes: [{ path: p, content: null }] },
    };
  }
  // Move: old and new path differ.
  if (oldPath !== newPath) {
    const oldP = oldPath as string;
    const newP = newPath as string;
    return {
      paths: [oldP, newP],
      run: (tree) => {
        if (!tree.has(oldP)) return { ok: false, code: "missing", path: oldP };
        if (tree.has(newP)) return { ok: false, code: "exists", path: newP };
        const r = applyHunks(tree.get(oldP) as string, sec.hunks, strict);
        if (!r.ok) return { ok: false, code: "no-match", path: oldP };
        return {
          ok: true,
          changes: [
            { path: oldP, content: null },
            { path: newP, content: r.content },
          ],
          move: { old: oldP, nw: newP },
        };
      },
    };
  }
  // Change of the one path.
  const p = oldPath as string;
  return {
    paths: [p],
    run: (tree) => {
      if (!tree.has(p)) return { ok: false, code: "missing", path: p };
      const orig = tree.get(p) as string;
      const r = applyHunks(orig, sec.hunks, strict);
      if (!r.ok) return { ok: false, code: "no-match", path: p };
      return { ok: true, changes: r.content === orig ? [] : [{ path: p, content: r.content }] };
    },
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: SecBuild[] = [];
  let cur: SecBuild | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith("diff --git ")) {
      const dg = parseDiffGit(l);
      if (!dg) throw new ParseErr(i + 1);
      cur = newSection();
      sections.push(cur);
      cur.diffOld = dg.x;
      cur.diffNew = dg.y;
      i++;
      continue;
    }
    if (l.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
      const op = parseDiffPath(l);
      const np = parseDiffPath(lines[i + 1]);
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.hasPair = true;
        cur.pairOld = op === "/dev/null" ? null : op;
        cur.pairNew = np === "/dev/null" ? null : np;
      } else {
        cur = newSection();
        sections.push(cur);
        cur.hasPair = true;
        cur.pairOld = op === "/dev/null" ? null : op;
        cur.pairNew = np === "/dev/null" ? null : np;
      }
      i += 2;
      continue;
    }
    if (l.startsWith("--- ")) {
      // A `--- ` line not followed by a `+++ ` line, inside a section's
      // header, is a parse error at the line after it.
      if (cur !== null && cur.hunks.length === 0) throw new ParseErr(Math.min(i + 2, n + 1));
      i++;
      continue;
    }
    if (l.startsWith("@@")) {
      if (cur === null) throw new ParseErr(i + 1);
      const a = parseHunkHeader(l);
      if (a === null) throw new ParseErr(i + 1);
      const { hunk, next } = parseHunkBody(lines, i + 1, a);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith("rename from ")) cur.renameFrom = l.slice("rename from ".length).trim();
      else if (l.startsWith("rename to ")) cur.renameTo = l.slice("rename to ".length).trim();
      else if (l === "new file mode" || l.startsWith("new file mode ")) cur.newFile = true;
      else if (l === "deleted file mode" || l.startsWith("deleted file mode ")) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => unifiedSectionToEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function makeSearchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    paths: [p],
    run: (tree) => {
      if (oldLines.length === 0) {
        if (tree.has(p)) return { ok: false, code: "exists", path: p };
        const content = newLines.length === 0 ? "" : newLines.join("\n") + "\n";
        return { ok: true, changes: [{ path: p, content }] };
      }
      if (!tree.has(p)) return { ok: false, code: "missing", path: p };
      const orig = tree.get(p) as string;
      const m = parseFile(orig);
      const found = firstTier(m.lines, oldLines, strict);
      if (!found) return { ok: false, code: "no-match", path: p };
      if (found.occ.length > 1) return { ok: false, code: "ambiguous", path: p };
      const block: Block = {
        o: oldLines,
        n: newLines,
        ctxN: newLines.map(() => false),
        ctxOMap: newLines.map(() => -1),
      };
      const lines = replaceAt(m.lines, found.occ[0], block, found.tier);
      const content = renderFile({ lines, br: m.br, finalBreak: m.finalBreak });
      return { ok: true, changes: content === orig ? [] : [{ path: p, content }] };
    },
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s++) {
    if (trimEndWs(lines[s]) !== "<<<<<<< SEARCH") continue;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks.
    let p: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("```")) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new ParseErr(s + 1);
      p = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (trimEndWs(lines[k]) === "=======") {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw new ParseErr(s + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (trimEndWs(lines[k]) === ">>>>>>> REPLACE") {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new ParseErr(s + 1);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(p, oldLines, newLines, strict));
    prevEnd = rep;
    prevPath = p;
    s = rep;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Array<{ kind: string; text: string; blank: boolean }>;
}

function makeV4aUpdateEdit(p: string, newPath: string | null, chunks: VChunk[], strict: boolean): Edit {
  const paths = newPath === null ? [p] : [p, newPath];
  return {
    paths,
    run: (tree) => {
      if (!tree.has(p)) return { ok: false, code: "missing", path: p };
      if (newPath !== null && tree.has(newPath)) return { ok: false, code: "exists", path: newPath };
      const orig = tree.get(p) as string;
      const m = parseFile(orig);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          // First find the anchor line at or after the cursor, at the
          // first tier where one is; the cursor moves past it.
          let foundIdx = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let k = cursor; k < m.lines.length; k++) {
              if (lineEq(m.lines[k], ch.anchor as string, t)) {
                foundIdx = k;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) return { ok: false, code: "no-match", path: p };
          cursor = foundIdx + 1;
        }
        const o: string[] = [];
        const n: string[] = [];
        const ctxN: boolean[] = [];
        const ctxOMap: number[] = [];
        for (const it of ch.items) {
          if (it.kind === "ctx") {
            ctxOMap.push(o.length);
            o.push(it.text);
            ctxN.push(true);
            n.push(it.text);
          } else if (it.kind === "old") {
            o.push(it.text);
          } else {
            ctxN.push(false);
            ctxOMap.push(-1);
            n.push(it.text);
          }
        }
        if (o.length > 0) {
          const tiers = strict ? [0] : [0, 1, 2];
          let chosen: { tier: number; at: number } | null = null;
          for (const t of tiers) {
            const occ = findOcc(m.lines, o, t).filter((x) => x >= cursor);
            const okOcc = ch.eof
              ? occ.filter((x) => x + o.length - 1 === m.lines.length - 1)
              : occ;
            if (okOcc.length > 0) {
              chosen = { tier: t, at: okOcc[0] };
              break;
            }
          }
          if (!chosen) return { ok: false, code: "no-match", path: p };
          const block: Block = { o, n, ctxN, ctxOMap };
          m.lines = replaceAt(m.lines, chosen.at, block, chosen.tier);
          cursor = chosen.at + n.length;
        } else {
          const pos = ch.eof ? m.lines.length : cursor;
          m.lines = [...m.lines.slice(0, pos), ...n, ...m.lines.slice(pos)];
          cursor = pos + n.length;
        }
      }
      const content = renderFile(m);
      if (newPath === null) {
        return { ok: true, changes: content === orig ? [] : [{ path: p, content }] };
      }
      return {
        ok: true,
        changes: [
          { path: p, content: null },
          { path: newPath, content },
        ],
        move: { old: p, nw: newPath },
      };
    },
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseErr(first + 1);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch") throw new ParseErr(lines.length + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ");
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (l.startsWith("*** Add File: ")) {
      const p = l.slice("*** Add File: ".length).trim();
      const items: Array<{ text: string; blank: boolean }> = [];
      i++;
      while (i < last && !isSectionStart(lines[i])) {
        const cl = lines[i];
        if (cl === "") {
          items.push({ text: "", blank: true });
          i++;
        } else if (cl.startsWith("+")) {
          items.push({ text: cl.slice(1), blank: false });
          i++;
        } else {
          throw new ParseErr(i + 1);
        }
      }
      // Blank lines at the end of a section are not part of it.
      while (items.length > 0 && items[items.length - 1].blank) items.pop();
      const fileLines = items.map((x) => x.text);
      edits.push({
        paths: [p],
        run: (tree) => {
          if (tree.has(p)) return { ok: false, code: "exists", path: p };
          const content = fileLines.length === 0 ? "" : fileLines.join("\n") + "\n";
          return { ok: true, changes: [{ path: p, content }] };
        },
      });
      continue;
    }
    if (l.startsWith("*** Delete File: ")) {
      const p = l.slice("*** Delete File: ".length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i])) {
        if (isBlank(lines[i])) {
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      edits.push({
        paths: [p],
        run: (tree) =>
          !tree.has(p)
            ? { ok: false, code: "missing", path: p }
            : { ok: true, changes: [{ path: p, content: null }] },
      });
      continue;
    }
    if (l.startsWith("*** Update File: ")) {
      const p = l.slice("*** Update File: ".length).trim();
      const updateLine = i;
      i++;
      let newPath: string | null = null;
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let firstChunk = true;
      const closeChunk = (stripTrailingBlank: boolean): void => {
        if (curChunk) {
          if (stripTrailingBlank) {
            while (curChunk.items.length > 0 && curChunk.items[curChunk.items.length - 1].blank) {
              curChunk.items.pop();
            }
          }
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (i < last && !isSectionStart(lines[i])) {
        const cl = lines[i];
        if (cl.startsWith("*** Move to: ") && curChunk === null && firstChunk && newPath === null) {
          newPath = cl.slice("*** Move to: ".length).trim();
          i++;
          continue;
        }
        if (cl === "*** End of File") {
          if (!curChunk) throw new ParseErr(i + 1);
          curChunk.eof = true;
          closeChunk(false);
          i++;
          continue;
        }
        if (cl.startsWith("@@")) {
          closeChunk(false);
          const anchor = cl.slice(2).trim();
          curChunk = { anchor: anchor === "" ? null : anchor, eof: false, items: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (isBlank(cl)) {
          // A blank line (empty or only whitespace) is an empty context
          // line while a chunk is open, and a blank line between sections
          // otherwise. Marking it blank lets the section-end strip drop
          // it: blank lines at the end of a section are not part of it,
          // so a trailing ` ` line must not become a context line the
          // file does not have.
          if (curChunk) curChunk.items.push({ kind: "ctx", text: "", blank: true });
          i++;
          continue;
        }
        if (cl.startsWith(" ") || cl.startsWith("-") || cl.startsWith("+")) {
          if (!curChunk) {
            if (!firstChunk) throw new ParseErr(i + 1);
            curChunk = { anchor: null, eof: false, items: [] };
            firstChunk = false;
          }
          if (cl.startsWith(" ")) curChunk.items.push({ kind: "ctx", text: cl.slice(1), blank: false });
          else if (cl.startsWith("-")) curChunk.items.push({ kind: "old", text: cl.slice(1), blank: false });
          else curChunk.items.push({ kind: "new", text: cl.slice(1), blank: false });
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      closeChunk(true);
      if (chunks.length === 0 && newPath === null) throw new ParseErr(updateLine + 1);
      edits.push(makeV4aUpdateEdit(p, newPath, chunks, strict));
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

interface JsonEditObj {
  command: string;
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function parseJsonEditObject(v: unknown): JsonEditObj | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  const cmd = o.command;
  if (cmd === "create") {
    if (typeof o.file_text !== "string") return null;
    return { command: cmd, path: o.path, file_text: o.file_text };
  }
  if (cmd === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str.length === 0) return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    return { command: cmd, path: o.path, old_str: o.old_str, new_str: o.new_str === undefined ? "" : o.new_str };
  }
  if (cmd === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return { command: cmd, path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function jsonEditToEdit(e: JsonEditObj): Edit {
  if (e.command === "create") {
    const p = e.path;
    const text = e.file_text as string;
    return {
      paths: [p],
      run: (tree) =>
        tree.has(p)
          ? { ok: false, code: "exists", path: p }
          : { ok: true, changes: [{ path: p, content: text }] },
    };
  }
  if (e.command === "str_replace") {
    const p = e.path;
    const oldStr = e.old_str as string;
    const newStr = e.new_str as string;
    return {
      paths: [p],
      run: (tree) => {
        if (!tree.has(p)) return { ok: false, code: "missing", path: p };
        const orig = tree.get(p) as string;
        const m = parseFile(orig);
        let t = orig;
        let o = oldStr;
        let n = newStr;
        if (m.br === "\r\n") {
          t = orig.replace(/\r\n/g, "\n");
          o = oldStr.replace(/\r\n/g, "\n");
          n = newStr.replace(/\r\n/g, "\n");
        }
        let count = 0;
        let idx = -1;
        let pos = 0;
        for (;;) {
          const j = t.indexOf(o, pos);
          if (j < 0) break;
          count++;
          if (idx < 0) idx = j;
          pos = j + 1;
        }
        if (count === 0) return { ok: false, code: "no-match", path: p };
        if (count > 1) return { ok: false, code: "ambiguous", path: p };
        let result = t.slice(0, idx) + n + t.slice(idx + o.length);
        if (m.br === "\r\n") result = result.replace(/\n/g, "\r\n");
        return { ok: true, changes: result === orig ? [] : [{ path: p, content: result }] };
      },
    };
  }
  const p = e.path;
  const il = e.insert_line as number;
  const ns = e.new_str as string;
  return {
    paths: [p],
    run: (tree) => {
      if (!tree.has(p)) return { ok: false, code: "missing", path: p };
      const orig = tree.get(p) as string;
      const m = parseFile(orig);
      if (il < 0 || il > m.lines.length) return { ok: false, code: "no-match", path: p };
      const ins = splitNewStr(ns);
      const nl = [...m.lines.slice(0, il), ...ins, ...m.lines.slice(il)];
      const content = renderFile({ lines: nl, br: m.br, finalBreak: m.finalBreak });
      return { ok: true, changes: content === orig ? [] : [{ path: p, content }] };
    },
  };
}

function parseJson(patchText: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let k = 0; k < patchText.length; k++) {
    const c = patchText[k];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
      firstIdx = k;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseErr(1);
  if (patchText[firstIdx] === "[") {
    const arrayStartLine = patchText.slice(0, firstIdx).split("\n").length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseErr(arrayStartLine);
    }
    if (!Array.isArray(parsed)) throw new ParseErr(arrayStartLine);
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = parseJsonEditObject(el);
      if (!e) throw new ParseErr(arrayStartLine);
      edits.push(jsonEditToEdit(e));
    }
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      throw new ParseErr(i + 1);
    }
    const e = parseJsonEditObject(parsed);
    if (!e) throw new ParseErr(i + 1);
    edits.push(jsonEditToEdit(e));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parsePatch(fmt: string, lines: string[], patchText: string, strict: boolean): Edit[] {
  if (fmt === "unified") return parseUnified(lines, strict);
  if (fmt === "search-replace") return parseSearchReplace(lines, strict);
  if (fmt === "v4a") return parseV4a(lines, strict);
  return parseJson(patchText, lines);
}

async function main(): Promise<number> {
  // In a trial the starter hands over to the kit's runner.
  if (process.env.MAKEFUN_ENV_URL) {
    const runner = await import("./runner.ts");
    await runner.runTrial(process.env.MAKEFUN_ENV_URL);
    return 0;
  }
  const args = parseCli(process.argv.slice(2));
  if (args === null) {
    process.stdout.write("error: usage\n");
    return 2;
  }
  let patchText: string;
  if (args.patch === null || args.patch === "-") {
    patchText = fs.readFileSync(0, "utf8");
  } else {
    try {
      patchText = fs.readFileSync(args.patch, "utf8");
    } catch {
      process.stdout.write("error: no-patch\n");
      return 2;
    }
  }
  const lines = splitPatch(patchText);
  let edits: Edit[];
  try {
    const fmt = args.format === "auto" ? detectFormat(lines) : args.format;
    if (fmt === null) {
      process.stdout.write("error: format\n");
      return 2;
    }
    edits = parsePatch(fmt, lines, patchText, args.strict);
  } catch (e) {
    if (e instanceof ParseErr) {
      process.stdout.write(`error: parse ${e.n}\n`);
      return 2;
    }
    throw e;
  }
  if (edits.length === 0) {
    process.stdout.write("error: parse 1\n");
    return 2;
  }
  const before = loadTree(process.cwd());
  const tree = new Map<string, string>(before);
  const failures: Array<{ code: string; path: string }> = [];
  const moves: Array<{ old: string; nw: string }> = [];
  for (const edit of edits) {
    // Every path an edit names is checked for safety before anything
    // else about it.
    let unsafePath: string | null = null;
    for (const p of edit.paths) {
      if (!isSafe(p)) {
        unsafePath = p;
        break;
      }
    }
    if (unsafePath !== null) {
      failures.push({ code: "unsafe", path: unsafePath });
      continue;
    }
    const res = edit.run(tree);
    if (!res.ok) {
      failures.push({ code: res.code as string, path: res.path as string });
      continue;
    }
    if (res.move) moves.push(res.move);
    for (const c of res.changes ?? []) {
      if (c.content === null) tree.delete(c.path);
      else tree.set(c.path, c.content);
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join("\n") + "\n");
    return 1;
  }
  const outLines = computeOutput(before, tree, moves);
  if (!args.check) writeTree(process.cwd(), before, tree);
  process.stdout.write(outLines.join("\n") + "\n");
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
  process.exitCode = 2;
});
