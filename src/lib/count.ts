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
  | { kind: 'soloBlock'; close: string }
  | { kind: 'string'; close: string; escape: boolean; multiline: boolean; interpolate: boolean };

/** A `${ ... }` region suspended inside a template literal. */
interface Interpolation {
  string: Extract<Mode, { kind: 'string' }>;
  /** Nesting depth of `{` inside the expression, so `}` closes the right one. */
  braceDepth: number;
}

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
  soloBlock: [string, string][];
  docString: [string, string][];
  nested: boolean;
  strings: StringSpec[];
  embeds: { open: string; close: string; syntax: string }[];
  regex: boolean;
}

/**
 * A `/` starts a regex literal only where a value may begin. This is the
 * standard heuristic (the same one syntax highlighters use): look at the last
 * significant character, or the last word if it was a keyword.
 *
 * `)` and `]` are deliberately absent — `(a + b) / 2` and `xs[0] / 2` are
 * division. `{` and `}` are present: `{ re: /x/ }` and `function f(){} /x/`.
 *
 * `<` and `>` are also absent, even though `a < /re/.source` parses: closing
 * tags (`</p>`) in JSX and in HTML-bearing template literals are orders of
 * magnitude more common than comparing against a regex, and treating `</` as a
 * literal swallows the rest of the line. Arrow functions are handled
 * separately, since `xs.filter(x => /a/.test(x))` is genuinely common.
 */
const REGEX_PRECEDING = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^',
]);

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

const compiledCache = new Map<Syntax, CompiledSyntax>();

function compile(syntax: Syntax): CompiledSyntax {
  const cached = compiledCache.get(syntax);
  if (cached) return cached;
  const compiled: CompiledSyntax = {
    line: sortByLength(syntax.line),
    block: sortByLength(syntax.block),
    lineStartBlock: sortByLength(syntax.lineStartBlock ?? []),
    soloBlock: sortByLength(syntax.soloBlock ?? []),
    docString: sortByLength(syntax.docString ?? []),
    nested: syntax.nestedBlock === true,
    strings: [...syntax.strings].sort((a, b) => b.open.length - a.open.length),
    embeds: syntax.embeds ?? [],
    regex: syntax.regex === true,
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
  /** Last significant code characters, and last word, for regex disambiguation. */
  let prevSignificant = '';
  let prevSignificant2 = '';
  let prevWord = '';
  /** Stack of (syntax, closing tag) for HTML <script>/<style> regions. */
  const embedStack: { syntax: CompiledSyntax; close: string }[] = [];
  /** Stack of template literals suspended by `${`. */
  const interpolations: Interpolation[] = [];

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

    if (mode.kind === 'soloBlock') {
      // The close (MATLAB `%}`) only ends the block when it stands alone on its
      // line: whitespace before it (leading whitespace is skipped above, so this
      // char being the first non-space means the line was blank until now) and
      // only whitespace after it. Otherwise every non-blank line inside counts
      // as comment, and a `%}` with trailing text keeps the block open.
      const atLead = !sawNonSpace;
      sawNonSpace = true;
      sawComment = true;
      if (atLead && startsWith(text, mode.close, i)) {
        const nl = text.indexOf('\n', i);
        const rest = text.slice(i + mode.close.length, nl === -1 ? n : nl);
        if (rest.trim() === '') {
          i += mode.close.length;
          mode = NORMAL;
          continue;
        }
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
      // `${` suspends a template literal and returns to real code, which may
      // itself contain nested template literals. Without this the backticks
      // stop balancing and everything after the first `${`x`}` is misread.
      if (mode.interpolate && ch === '$' && text[i + 1] === '{') {
        interpolations.push({ string: mode, braceDepth: 0 });
        mode = NORMAL;
        prevSignificant = '';
        prevWord = '';
        i += 2;
        continue;
      }
      if (startsWith(text, mode.close, i)) {
        i += mode.close.length;
        mode = NORMAL;
        // A string is a value: `"a" / 2` is division, not a regex.
        prevSignificant = 'x';
        prevWord = '';
        continue;
      }
      i++;
      continue;
    }

    // ---- normal mode -------------------------------------------------------
    // Whether this is the first non-whitespace character on the line, captured
    // before the flag is set, for the solo-block (MATLAB %{) open check below.
    const atLineLead = !sawNonSpace;
    sawNonSpace = true;

    // Closing brace of a `${ ... }` returns to the template literal it opened in.
    const interpolation = interpolations[interpolations.length - 1];
    if (interpolation !== undefined && (ch === '{' || ch === '}')) {
      sawCode = true;
      if (ch === '{') {
        interpolation.braceDepth++;
      } else if (interpolation.braceDepth === 0) {
        interpolations.pop();
        mode = interpolation.string;
        i++;
        continue;
      } else {
        interpolation.braceDepth--;
      }
      prevSignificant = ch;
      prevWord = '';
      i++;
      continue;
    }

    // Leaving an embedded <script>/<style> region.
    const top = embedStack[embedStack.length - 1];
    if (top && startsWithCI(text, top.close, i)) {
      embedStack.pop();
      active = embedStack.length > 0 ? embedStack[embedStack.length - 1]!.syntax : compile(rootSyntax);
      sawCode = true;
      prevSignificant = 'x';
      prevWord = '';
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

    // Solo block comments (MATLAB %{ %}): the open must be the first non-space
    // on its line (indentation allowed) and be alone, with only whitespace after
    // it. A `%{ trailing` falls through to the `%` line comment instead of
    // opening a block that would run to the next `%}`.
    if (active.soloBlock.length > 0 && atLineLead) {
      let matched = false;
      for (const [open, close] of active.soloBlock) {
        if (!startsWith(text, open, i)) continue;
        const nl = text.indexOf('\n', i);
        const rest = text.slice(i + open.length, nl === -1 ? n : nl);
        if (rest.trim() !== '') continue; // not alone on the line: a line comment
        sawComment = true;
        mode = { kind: 'soloBlock', close };
        i += open.length;
        matched = true;
        break;
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
          mode = { kind: 'string', close, escape: true, multiline: true, interpolate: false };
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

    // Regex literals. This runs *after* the comment checks, so `x = /* c */ 1`
    // is still a comment; it only claims a `/` that is not `//` or `/*`. Once
    // claimed, the whole literal is consumed, which is what stops a `/*` inside
    // a pattern from opening a block comment.
    const afterArrow = prevSignificant === '>' && prevSignificant2 === '=';
    if (
      active.regex &&
      ch === '/' &&
      (REGEX_KEYWORDS.has(prevWord) || REGEX_PRECEDING.has(prevSignificant) || afterArrow)
    ) {
      sawCode = true;
      i++;
      let inClass = false;
      while (i < n) {
        const c = text[i]!;
        if (c === '\n') break; // regex literals cannot span lines: recover
        if (c === '\\') {
          i += text[i + 1] === '\n' || i + 1 >= n ? 1 : 2;
          continue;
        }
        i++;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      // A regex is a value, so a following `/` is division.
      prevSignificant = 'x';
      prevWord = '';
      continue;
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
          // A fresh program starts here, so a leading regex literal is legal.
          prevSignificant = '';
          prevWord = '';
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
        mode = {
          kind: 'string',
          close: spec.close,
          escape: spec.escape,
          multiline: spec.multiline,
          interpolate: spec.interpolate === true,
        };
        i += spec.open.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    sawCode = true;
    prevSignificant2 = prevSignificant;
    prevSignificant = ch;
    prevWord = isWordChar(ch) ? prevWord + ch : '';
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
