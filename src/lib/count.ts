/**
 * Line classifier.
 *
 * A single pass over the file, tracking whether the current line has seen any
 * code, any comment, and any non-whitespace at all. At each newline the line is
 * charged to exactly one bucket:
 *
 *   blank    nothing but whitespace (even inside a block comment — matches cloc)
 *   code     at least one non-comment, non-whitespace character
 *   comment  non-blank, and everything on it was comment
 *
 * lines === code + comment + blank, always.
 *
 * String literals are tracked so that a `//` inside "http://example.com" is not
 * mistaken for a comment. Block comments nest where the language nests them.
 * Python/Elixir triple-quoted strings count as comments when they *open* a line
 * (docstrings) and as code otherwise.
 */

import {
  detectLanguage,
  hasCommentRules,
  refineWithContent,
  syntaxFor,
  type StringSpec,
  type Syntax,
} from './languages';

export interface LineCounts {
  lines: number;
  code: number;
  comment: number;
  blank: number;
}

export const ZERO: LineCounts = { lines: 0, code: 0, comment: 0, blank: 0 };

type Mode =
  | { kind: 'normal' }
  | { kind: 'block'; open: string; close: string; depth: number; nested: boolean }
  | { kind: 'string'; close: string; escape: boolean; multiline: boolean };

const NORMAL: Mode = { kind: 'normal' };

function startsWith(text: string, token: string, at: number): boolean {
  return text.startsWith(token, at);
}

function startsWithCI(text: string, token: string, at: number): boolean {
  const end = at + token.length;
  if (end > text.length) return false;
  return text.slice(at, end).toLowerCase() === token;
}

/** Longest-token-first so "--[[" wins over "--" and "REM " over "R". */
function sortByLength<T extends string | [string, string]>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const as = typeof a === 'string' ? a.length : a[0].length;
    const bs = typeof b === 'string' ? b.length : b[0].length;
    return bs - as;
  });
}

interface CompiledSyntax {
  line: string[];
  block: [string, string][];
  lineStartBlock: [string, string][];
  docString: [string, string][];
  nested: boolean;
  strings: StringSpec[];
  embeds: { open: string; close: string; syntax: string }[];
}

const compiledCache = new Map<Syntax, CompiledSyntax>();

function compile(syntax: Syntax): CompiledSyntax {
  const cached = compiledCache.get(syntax);
  if (cached) return cached;
  const compiled: CompiledSyntax = {
    line: sortByLength(syntax.line),
    block: sortByLength(syntax.block),
    lineStartBlock: sortByLength(syntax.lineStartBlock ?? []),
    docString: sortByLength(syntax.docString ?? []),
    nested: syntax.nestedBlock === true,
    strings: [...syntax.strings].sort((a, b) => b.open.length - a.open.length),
    embeds: syntax.embeds ?? [],
  };
  compiledCache.set(syntax, compiled);
  return compiled;
}

/** blank vs non-blank only — used when we have no comment rules for the file. */
export function countBlankOnly(text: string): LineCounts {
  const body = stripBom(text);
  if (body.length === 0) return { ...ZERO };
  let lines = 0;
  let blank = 0;
  let code = 0;
  let hasNonSpace = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\n') {
      lines++;
      if (hasNonSpace) code++;
      else blank++;
      hasNonSpace = false;
      continue;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\f' && ch !== '\v') {
      hasNonSpace = true;
    }
  }
  if (body[body.length - 1] !== '\n') {
    lines++;
    if (hasNonSpace) code++;
    else blank++;
  }
  return { lines, code, comment: 0, blank };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Count a single file's lines with full comment awareness for `language`.
 * Falls back to blank/non-blank when the language has no rules.
 */
export function countLines(text: string, language: string): LineCounts {
  const syntax = syntaxFor(language);
  if (!syntax) return countBlankOnly(text);
  return classify(stripBom(text), syntax);
}

function classify(text: string, rootSyntax: Syntax): LineCounts {
  const n = text.length;
  if (n === 0) return { ...ZERO };

  let lines = 0;
  let code = 0;
  let comment = 0;
  let blank = 0;

  let sawCode = false;
  let sawComment = false;
  let sawNonSpace = false;
  let lineStart = 0;

  let mode: Mode = NORMAL;
  let active = compile(rootSyntax);
  /** Stack of (syntax, closing tag) for HTML <script>/<style> regions. */
  const embedStack: { syntax: CompiledSyntax; close: string }[] = [];

  let i = 0;
  while (i < n) {
    const ch = text[i]!;

    if (ch === '\n') {
      lines++;
      if (!sawNonSpace) blank++;
      else if (sawCode) code++;
      else if (sawComment) comment++;
      else code++;
      sawCode = false;
      sawComment = false;
      sawNonSpace = false;
      i++;
      lineStart = i;
      // Unterminated single-line string: recover at the newline.
      if (mode.kind === 'string' && !mode.multiline) mode = NORMAL;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }

    if (mode.kind === 'block') {
      sawNonSpace = true;
      sawComment = true;
      if (mode.nested && startsWith(text, mode.open, i)) {
        mode = { ...mode, depth: mode.depth + 1 };
        i += mode.open.length;
        continue;
      }
      if (startsWith(text, mode.close, i)) {
        const depth = mode.depth - 1;
        i += mode.close.length;
        mode = depth <= 0 ? NORMAL : { ...mode, depth };
        continue;
      }
      i++;
      continue;
    }

    if (mode.kind === 'string') {
      sawNonSpace = true;
      sawCode = true;
      if (mode.escape && ch === '\\') {
        // Never step over a newline: it has to be counted.
        i += text[i + 1] === '\n' || i + 1 >= n ? 1 : 2;
        continue;
      }
      if (startsWith(text, mode.close, i)) {
        i += mode.close.length;
        mode = NORMAL;
        continue;
      }
      i++;
      continue;
    }

    // ---- normal mode -------------------------------------------------------
    sawNonSpace = true;

    // Leaving an embedded <script>/<style> region.
    const top = embedStack[embedStack.length - 1];
    if (top && startsWithCI(text, top.close, i)) {
      embedStack.pop();
      active = embedStack.length > 0 ? embedStack[embedStack.length - 1]!.syntax : compile(rootSyntax);
      sawCode = true;
      i += top.close.length;
      continue;
    }

    // Column-anchored block comments (Ruby =begin ... =end, Perl POD).
    if (active.lineStartBlock.length > 0 && i === lineStart) {
      let matched = false;
      for (const [open, close] of active.lineStartBlock) {
        if (startsWith(text, open, i)) {
          sawComment = true;
          mode = { kind: 'block', open, close, depth: 1, nested: false };
          i += open.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    // Triple-quoted strings: docstring (comment) when they open the line,
    // ordinary multiline string otherwise.
    if (active.docString.length > 0) {
      let matched = false;
      for (const [open, close] of active.docString) {
        if (!startsWith(text, open, i)) continue;
        if (sawCode) {
          mode = { kind: 'string', close, escape: true, multiline: true };
        } else {
          sawComment = true;
          mode = { kind: 'block', open, close, depth: 1, nested: false };
        }
        i += open.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    // Block comments before line comments: "--[[" must beat "--".
    {
      let matched = false;
      for (const [open, close] of active.block) {
        if (!startsWith(text, open, i)) continue;
        sawComment = true;
        mode = { kind: 'block', open, close, depth: 1, nested: active.nested };
        i += open.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    {
      let matched = false;
      for (const token of active.line) {
        if (!startsWith(text, token, i)) continue;
        sawComment = true;
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? n : nl;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    // Entering an embedded region.
    if (active.embeds.length > 0 && ch === '<') {
      let matched = false;
      for (const embed of active.embeds) {
        if (!startsWithCI(text, embed.open, i)) continue;
        const gt = text.indexOf('>', i);
        const nl = text.indexOf('\n', i);
        // A tag that never closes on sane input: treat as plain code.
        if (gt === -1) break;
        sawCode = true;
        const inner = syntaxFor(embed.syntax);
        // Skip the tag itself; if the tag spans lines let the loop count them.
        if (nl !== -1 && nl < gt) {
          i += embed.open.length;
        } else {
          i = gt + 1;
        }
        if (inner) {
          const compiled = compile(inner);
          embedStack.push({ syntax: compiled, close: embed.close });
          active = compiled;
        }
        matched = true;
        break;
      }
      if (matched) continue;
    }

    {
      let matched = false;
      for (const spec of active.strings) {
        if (!startsWith(text, spec.open, i)) continue;
        sawCode = true;
        mode = { kind: 'string', close: spec.close, escape: spec.escape, multiline: spec.multiline };
        i += spec.open.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    sawCode = true;
    i++;
  }

  // Final line without a trailing newline.
  if (text[n - 1] !== '\n') {
    lines++;
    if (!sawNonSpace) blank++;
    else if (sawCode) code++;
    else if (sawComment) comment++;
    else code++;
  }

  return { lines, code, comment, blank };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface LanguageRow extends LineCounts {
  language: string;
  files: number;
  bytes: number;
}

export interface Totals extends LineCounts {
  files: number;
  bytes: number;
}

export class Aggregator {
  private readonly byLanguage = new Map<string, LanguageRow>();
  readonly totals: Totals = { files: 0, bytes: 0, lines: 0, code: 0, comment: 0, blank: 0 };
  /** Languages seen that have no comment rules — surfaced honestly in the UI. */
  readonly languagesWithoutCommentRules = new Set<string>();
  /** Largest files by line count, for the "biggest files" table. */
  private readonly largest: { path: string; lines: number; language: string }[] = [];

  add(path: string, language: string, bytes: number, counts: LineCounts): void {
    let row = this.byLanguage.get(language);
    if (!row) {
      row = { language, files: 0, bytes: 0, lines: 0, code: 0, comment: 0, blank: 0 };
      this.byLanguage.set(language, row);
    }
    row.files += 1;
    row.bytes += bytes;
    row.lines += counts.lines;
    row.code += counts.code;
    row.comment += counts.comment;
    row.blank += counts.blank;

    this.totals.files += 1;
    this.totals.bytes += bytes;
    this.totals.lines += counts.lines;
    this.totals.code += counts.code;
    this.totals.comment += counts.comment;
    this.totals.blank += counts.blank;

    if (!hasCommentRules(language)) this.languagesWithoutCommentRules.add(language);

    this.trackLargest(path, language, counts.lines);
  }

  private trackLargest(path: string, language: string, lines: number): void {
    const LIMIT = 10;
    if (this.largest.length >= LIMIT && lines <= this.largest[this.largest.length - 1]!.lines) return;
    this.largest.push({ path, lines, language });
    this.largest.sort((a, b) => b.lines - a.lines);
    if (this.largest.length > LIMIT) this.largest.length = LIMIT;
  }

  languages(): LanguageRow[] {
    return [...this.byLanguage.values()].sort(
      (a, b) => b.code - a.code || b.lines - a.lines || a.language.localeCompare(b.language),
    );
  }

  biggestFiles(): { path: string; lines: number; language: string }[] {
    return [...this.largest];
  }
}

// ---------------------------------------------------------------------------
// File-level helper
// ---------------------------------------------------------------------------

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

export interface CountedFile {
  path: string;
  language: string;
  bytes: number;
  counts: LineCounts;
}

/**
 * Decode + detect + count one file. `detectLanguage` handles the path; the
 * first line is then used to refine unknown files via shebang.
 */
export function countFile(path: string, bytes: Uint8Array): CountedFile {
  const text = decoder.decode(bytes);
  let language = detectLanguage(path);
  if (language === 'Other' || language === 'Text') {
    const firstNewline = text.indexOf('\n');
    const firstLine = firstNewline === -1 ? text.slice(0, 200) : text.slice(0, firstNewline);
    language = refineWithContent(language, firstLine);
  }
  return { path, language, bytes: bytes.length, counts: countLines(text, language) };
}
