/**
 * Language detection + per-language comment syntax.
 *
 * Two things live here:
 *  1. `detectLanguage(path)` — extension map plus filename heuristics.
 *  2. `SYNTAX` — comment/string rules used by the line classifier in count.ts.
 *
 * A language with no entry in SYNTAX is still counted, but only as
 * blank vs non-blank (everything non-blank becomes "code", comments 0). The UI
 * states this explicitly rather than pretending to precision we do not have.
 */

export interface StringSpec {
  open: string;
  close: string;
  /** Backslash escaping inside the literal. */
  escape: boolean;
  /** May the literal span lines? (template literals, heredocs, python triples) */
  multiline: boolean;
  /**
   * `${ ... }` interpolation returns to real code, which may contain further
   * template literals. Only true for ECMAScript template literals; Go's
   * backtick strings are raw.
   */
  interpolate?: boolean;
}

export interface EmbedSpec {
  /** Opening tag prefix, matched case-insensitively, e.g. "<script". */
  open: string;
  /** Closing tag prefix, e.g. "</script". */
  close: string;
  /** Syntax to use inside the region. */
  syntax: string;
}

export interface Syntax {
  line: string[];
  block: [string, string][];
  /** Rust/Swift/Haskell style nesting block comments. */
  nestedBlock?: boolean;
  strings: StringSpec[];
  /**
   * Block comments that are only recognised when they start a line
   * (Ruby's =begin/=end, Elixir/Perl POD, Lua-free forms).
   */
  lineStartBlock?: [string, string][];
  /**
   * Triple-quoted strings that count as comments when they *begin* a line
   * (Python docstrings). Elsewhere they are treated as ordinary strings.
   */
  docString?: [string, string][];
  /** Sub-language regions (HTML <script>/<style>). Best effort. */
  embeds?: EmbedSpec[];
  /**
   * ECMAScript-style `/.../` regex literals. Needed so that a regex containing
   * `/*` — e.g. `str.match(/^([^\/]+:\/)?\/*$/)` — is not read as the start of a
   * block comment. Only set for the JS family: in languages without regex
   * literals every `/` is division, and enabling this would create false
   * positives.
   */
  regex?: boolean;
}

const DQ: StringSpec = { open: '"', close: '"', escape: true, multiline: false };
const SQ: StringSpec = { open: "'", close: "'", escape: true, multiline: false };
const BACKTICK: StringSpec = { open: '`', close: '`', escape: true, multiline: true };
const JS_BACKTICK: StringSpec = { open: '`', close: '`', escape: true, multiline: true, interpolate: true };
const DQ_RAW: StringSpec = { open: '"', close: '"', escape: false, multiline: false };
const SQ_RAW: StringSpec = { open: "'", close: "'", escape: false, multiline: false };

// Triple-quoted multiline strings (Kotlin/Scala/Swift/Dart/Groovy raw blocks).
// Modelling them as strings is what stops a `/*` inside one from being read as
// the start of a runaway block comment once the newline resets string mode.
const TRIPLE_DQ: StringSpec = { open: '"""', close: '"""', escape: false, multiline: true };
const TRIPLE_SQ: StringSpec = { open: "'''", close: "'''", escape: false, multiline: true };
// C# verbatim string @"...". `""` escapes a quote; modelled as multiline with no
// backslash escaping, which is right for line counting even if it closes early
// on the rare embedded "" — still far better than treating it as ordinary code.
const CS_VERBATIM: StringSpec = { open: '@"', close: '"', escape: false, multiline: true };
// Rust ordinary strings can span lines, and raw strings r"..." / r#"..."# carry
// no escaping. Longer opens are tried first (compile sorts by open length).
const RUST_DQ: StringSpec = { open: '"', close: '"', escape: true, multiline: true };
const RUST_RAW_HASH: StringSpec = { open: 'r#"', close: '"#', escape: false, multiline: true };
const RUST_RAW: StringSpec = { open: 'r"', close: '"', escape: false, multiline: true };

const C_LIKE: Syntax = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: [DQ, SQ],
};

const C_LIKE_TEMPLATE: Syntax = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: [DQ, SQ, BACKTICK],
};

/** C-like plus template literals plus regex literals: the JavaScript family. */
const JS_LIKE: Syntax = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: [DQ, SQ, JS_BACKTICK],
  regex: true,
};

const HASH: Syntax = {
  line: ['#'],
  block: [],
  strings: [DQ, SQ],
};

const CSS_SYNTAX: Syntax = {
  line: [],
  block: [['/*', '*/']],
  strings: [DQ, SQ],
};

const HTML_SYNTAX: Syntax = {
  line: [],
  block: [['<!--', '-->']],
  strings: [],
  embeds: [
    { open: '<script', close: '</script', syntax: 'JavaScript' },
    { open: '<style', close: '</style', syntax: 'CSS' },
  ],
};

const SQL_SYNTAX: Syntax = {
  line: ['--'],
  block: [['/*', '*/']],
  strings: [DQ, SQ],
};

const LUA_SYNTAX: Syntax = {
  line: ['--'],
  block: [
    ['--[[', ']]'],
    ['--[=[', ']=]'],
  ],
  strings: [DQ, SQ, { open: '[[', close: ']]', escape: false, multiline: true }],
};

/** Comment/string rules keyed by language name. */
export const SYNTAX: Record<string, Syntax> = {
  'C': C_LIKE,
  'C++': C_LIKE,
  'C Header': C_LIKE,
  'C#': { ...C_LIKE, strings: [TRIPLE_DQ, CS_VERBATIM, DQ, SQ] },
  'Objective-C': C_LIKE,
  'Java': C_LIKE,
  'Kotlin': { ...C_LIKE, nestedBlock: true, strings: [TRIPLE_DQ, DQ, SQ] },
  'Scala': { ...C_LIKE, strings: [TRIPLE_DQ, DQ, SQ] },
  'Go': C_LIKE_TEMPLATE,
  'Rust': { line: ['//'], block: [['/*', '*/']], nestedBlock: true, strings: [RUST_RAW_HASH, RUST_RAW, RUST_DQ, SQ] },
  'Swift': { line: ['//'], block: [['/*', '*/']], nestedBlock: true, strings: [TRIPLE_DQ, DQ] },
  'JavaScript': JS_LIKE,
  'JSX': JS_LIKE,
  'TypeScript': JS_LIKE,
  'TSX': JS_LIKE,
  'JSON with Comments': C_LIKE,
  'Dart': { line: ['//'], block: [['/*', '*/']], nestedBlock: true, strings: [TRIPLE_DQ, TRIPLE_SQ, DQ, SQ] },
  'PHP': { line: ['//', '#'], block: [['/*', '*/']], strings: [DQ, SQ] },
  'D': C_LIKE,
  'Zig': { line: ['//'], block: [], strings: [DQ, SQ] },
  'V': C_LIKE,
  'Solidity': C_LIKE,
  'GLSL': C_LIKE,
  'HLSL': C_LIKE,
  'Groovy': { line: ['//'], block: [['/*', '*/']], strings: [TRIPLE_DQ, TRIPLE_SQ, DQ, SQ] },
  'Verilog': C_LIKE,
  'VHDL': { line: ['--'], block: [], strings: [DQ] },
  'Protocol Buffers': C_LIKE,
  'Thrift': C_LIKE,
  'GraphQL': { line: ['#'], block: [], strings: [DQ] },
  'Less': CSS_SYNTAX,
  'SCSS': { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ] },
  'Sass': { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ] },
  'CSS': CSS_SYNTAX,
  'Stylus': { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ] },
  'HTML': HTML_SYNTAX,
  'Vue': HTML_SYNTAX,
  'Svelte': HTML_SYNTAX,
  'XML': { line: [], block: [['<!--', '-->']], strings: [] },
  'SVG': { line: [], block: [['<!--', '-->']], strings: [] },
  'Markdown': { line: [], block: [['<!--', '-->']], strings: [] },
  'Handlebars': { line: [], block: [['{{!--', '--}}'], ['{{!', '}}'], ['<!--', '-->']], strings: [] },
  'Twig': { line: [], block: [['{#', '#}'], ['<!--', '-->']], strings: [] },
  'Jinja': { line: [], block: [['{#', '#}'], ['<!--', '-->']], strings: [] },
  'Python': {
    line: ['#'],
    block: [],
    strings: [DQ, SQ],
    docString: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
  },
  'Ruby': {
    line: ['#'],
    block: [],
    lineStartBlock: [['=begin', '=end']],
    strings: [DQ, SQ],
  },
  'Crystal': HASH,
  'Perl': { line: ['#'], block: [], lineStartBlock: [['=pod', '=cut'], ['=head', '=cut']], strings: [DQ, SQ] },
  'Shell': { line: ['#'], block: [], strings: [DQ, SQ_RAW] },
  'Fish': { line: ['#'], block: [], strings: [DQ, SQ_RAW] },
  'PowerShell': { line: ['#'], block: [['<#', '#>']], strings: [DQ, SQ_RAW] },
  'Batch': { line: ['rem ', 'REM ', '::'], block: [], strings: [DQ_RAW] },
  'Makefile': HASH,
  'CMake': HASH,
  'Dockerfile': HASH,
  'YAML': { line: ['#'], block: [], strings: [DQ, SQ_RAW] },
  'TOML': { line: ['#'], block: [], strings: [DQ, SQ_RAW] },
  'INI': { line: [';', '#'], block: [], strings: [DQ, SQ_RAW] },
  'Properties': { line: ['#', '!'], block: [], strings: [] },
  'HCL': { line: ['#', '//'], block: [['/*', '*/']], strings: [DQ] },
  'Nix': { line: ['#'], block: [['/*', '*/']], strings: [DQ] },
  'R': HASH,
  'Julia': { line: ['#'], block: [['#=', '=#']], nestedBlock: true, strings: [DQ, SQ] },
  'Elixir': { line: ['#'], block: [], strings: [DQ, SQ], docString: [['"""', '"""']] },
  'Erlang': { line: ['%'], block: [], strings: [DQ] },
  'Haskell': { line: ['--'], block: [['{-', '-}']], nestedBlock: true, strings: [DQ] },
  'PureScript': { line: ['--'], block: [['{-', '-}']], nestedBlock: true, strings: [DQ] },
  'Elm': { line: ['--'], block: [['{-', '-}']], nestedBlock: true, strings: [DQ] },
  'OCaml': { line: [], block: [['(*', '*)']], nestedBlock: true, strings: [DQ] },
  'F#': { line: ['//'], block: [['(*', '*)']], nestedBlock: true, strings: [DQ] },
  'Pascal': { line: ['//'], block: [['(*', '*)'], ['{', '}']], strings: [SQ_RAW] },
  'Clojure': { line: [';'], block: [], strings: [DQ] },
  'Lisp': { line: [';'], block: [['#|', '|#']], nestedBlock: true, strings: [DQ] },
  'Scheme': { line: [';'], block: [['#|', '|#']], nestedBlock: true, strings: [DQ] },
  'Emacs Lisp': { line: [';'], block: [], strings: [DQ] },
  'Lua': LUA_SYNTAX,
  'SQL': SQL_SYNTAX,
  'PLpgSQL': SQL_SYNTAX,
  'Assembly': { line: [';', '#'], block: [['/*', '*/']], strings: [DQ, SQ] },
  'Fortran': { line: ['!'], block: [], strings: [DQ, SQ] },
  // %{ %} is a block comment only when it stands alone on its own line, like
  // Ruby's =begin/=end. Declaring it as a general inline block let an inline
  // `%{` (or a `%{...}` with no later `%}`) open a block comment that ran to the
  // end of the file; as a line-start block plus the `%` line comment, an inline
  // %{ is just an ordinary comment to end of line.
  'MATLAB': { line: ['%'], block: [], lineStartBlock: [['%{', '%}']], strings: [DQ, SQ_RAW] },
  'Tcl': HASH,
  'Vim script': { line: ['"'], block: [], strings: [SQ_RAW] },
  'AWK': HASH,
  'Nim': { line: ['#'], block: [['#[', ']#']], nestedBlock: true, strings: [DQ, SQ] },
  'Racket': { line: [';'], block: [['#|', '|#']], nestedBlock: true, strings: [DQ] },
  'Coq': { line: [], block: [['(*', '*)']], nestedBlock: true, strings: [DQ] },
  'Terraform': { line: ['#', '//'], block: [['/*', '*/']], strings: [DQ] },
  'Astro': HTML_SYNTAX,
  'CoffeeScript': { line: ['#'], block: [['###', '###']], strings: [DQ, SQ] },
  'Visual Basic': { line: ["'"], block: [], strings: [DQ_RAW] },
  'ReScript': C_LIKE,
  'Odin': C_LIKE,
  'Mojo': {
    line: ['#'],
    block: [],
    strings: [DQ, SQ],
    docString: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
  },
};

/** extension (without dot, lowercased) -> language name */
export const EXT_LANG: Record<string, string> = {
  // web
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  tsx: 'TSX',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', styl: 'Stylus',
  hbs: 'Handlebars', handlebars: 'Handlebars', mustache: 'Handlebars',
  twig: 'Twig', jinja: 'Jinja', jinja2: 'Jinja', j2: 'Jinja',
  ejs: 'HTML', erb: 'HTML', njk: 'Jinja',
  // systems
  c: 'C', h: 'C Header',
  cc: 'C++', cpp: 'C++', cxx: 'C++', 'c++': 'C++',
  hh: 'C++', hpp: 'C++', hxx: 'C++', ipp: 'C++', inl: 'C++', tpp: 'C++',
  m: 'Objective-C', mm: 'Objective-C',
  rs: 'Rust', go: 'Go', zig: 'Zig', d: 'D', v: 'V', odin: 'Odin', nim: 'Nim',
  swift: 'Swift', kt: 'Kotlin', kts: 'Kotlin', java: 'Java', scala: 'Scala', sc: 'Scala',
  cs: 'C#', csx: 'C#', fs: 'F#', fsi: 'F#', fsx: 'F#', vb: 'Visual Basic',
  dart: 'Dart', groovy: 'Groovy', gradle: 'Groovy',
  // scripting
  py: 'Python', pyi: 'Python', pyw: 'Python', mojo: 'Mojo',
  rb: 'Ruby', rake: 'Ruby', gemspec: 'Ruby', cr: 'Crystal',
  pl: 'Perl', pm: 'Perl', t: 'Perl',
  php: 'PHP', php3: 'PHP', php4: 'PHP', php5: 'PHP', phtml: 'PHP',
  lua: 'Lua', tcl: 'Tcl', awk: 'AWK', r: 'R', jl: 'Julia',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ksh: 'Shell', ash: 'Shell', command: 'Shell',
  fish: 'Fish', ps1: 'PowerShell', psm1: 'PowerShell', psd1: 'PowerShell',
  bat: 'Batch', cmd: 'Batch',
  coffee: 'CoffeeScript', vim: 'Vim script', el: 'Emacs Lisp',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hrl: 'Erlang',
  hs: 'Haskell', lhs: 'Haskell', purs: 'PureScript', elm: 'Elm',
  ml: 'OCaml', mli: 'OCaml', re: 'ReScript', res: 'ReScript', resi: 'ReScript',
  clj: 'Clojure', cljs: 'Clojure', cljc: 'Clojure', edn: 'Clojure',
  lisp: 'Lisp', lsp: 'Lisp', cl: 'Lisp', scm: 'Scheme', ss: 'Scheme', rkt: 'Racket',
  pas: 'Pascal', pp: 'Pascal', dpr: 'Pascal',
  f: 'Fortran', f90: 'Fortran', f95: 'Fortran', f03: 'Fortran', for: 'Fortran',
  s: 'Assembly', asm: 'Assembly', nasm: 'Assembly',
  vhd: 'VHDL', vhdl: 'VHDL', sv: 'Verilog', svh: 'Verilog',
  sol: 'Solidity', glsl: 'GLSL', vert: 'GLSL', frag: 'GLSL', hlsl: 'HLSL',
  // data / config / docs
  json: 'JSON', json5: 'JSON with Comments', jsonc: 'JSON with Comments',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  ini: 'INI', cfg: 'INI', conf: 'INI', properties: 'Properties',
  xml: 'XML', xsd: 'XML', xsl: 'XML', xslt: 'XML', plist: 'XML', svg: 'SVG',
  csv: 'CSV', tsv: 'CSV',
  md: 'Markdown', markdown: 'Markdown', mdx: 'Markdown', rst: 'reStructuredText',
  txt: 'Text', text: 'Text', adoc: 'AsciiDoc', asciidoc: 'AsciiDoc', org: 'Org',
  tex: 'TeX', bib: 'BibTeX',
  sql: 'SQL', psql: 'PLpgSQL', prisma: 'Prisma', graphql: 'GraphQL', gql: 'GraphQL',
  proto: 'Protocol Buffers', thrift: 'Thrift', avsc: 'JSON',
  tf: 'Terraform', tfvars: 'Terraform', hcl: 'HCL', nix: 'Nix',
  cmake: 'CMake', mk: 'Makefile', make: 'Makefile',
  ipynb: 'Jupyter Notebook',
  patch: 'Diff', diff: 'Diff',
  http: 'HTTP', rest: 'HTTP',
  env: 'Dotenv',
  coq: 'Coq',
};

/** Exact filenames (lowercased) -> language. Checked before extensions. */
export const FILENAME_LANG: Record<string, string> = {
  'makefile': 'Makefile',
  'gnumakefile': 'Makefile',
  'makefile.am': 'Makefile',
  'makefile.in': 'Makefile',
  'dockerfile': 'Dockerfile',
  'containerfile': 'Dockerfile',
  'cmakelists.txt': 'CMake',
  'rakefile': 'Ruby',
  'gemfile': 'Ruby',
  'guardfile': 'Ruby',
  'capfile': 'Ruby',
  'vagrantfile': 'Ruby',
  'brewfile': 'Ruby',
  'podfile': 'Ruby',
  'fastfile': 'Ruby',
  'appfile': 'Ruby',
  'berksfile': 'Ruby',
  'jenkinsfile': 'Groovy',
  'justfile': 'Makefile',
  '.gitignore': 'Ignore List',
  '.gitattributes': 'Ignore List',
  '.dockerignore': 'Ignore List',
  '.npmignore': 'Ignore List',
  '.eslintignore': 'Ignore List',
  '.prettierignore': 'Ignore List',
  '.editorconfig': 'INI',
  '.env': 'Dotenv',
  '.env.example': 'Dotenv',
  '.babelrc': 'JSON',
  '.eslintrc': 'JSON',
  '.prettierrc': 'JSON',
  '.bashrc': 'Shell',
  '.zshrc': 'Shell',
  '.bash_profile': 'Shell',
  '.profile': 'Shell',
  'license': 'Text',
  'licence': 'Text',
  'notice': 'Text',
  'authors': 'Text',
  'copying': 'Text',
  'codeowners': 'Text',
  'go.mod': 'Go Module',
  'go.sum': 'Checksums',
};

/** Files that have no comment syntax, only blank vs non-blank. */
export const NO_COMMENT_LANGUAGES = new Set([
  'JSON', 'CSV', 'Text', 'Dotenv', 'Ignore List', 'Checksums', 'Go Module',
  'Diff', 'HTTP', 'reStructuredText', 'AsciiDoc', 'Org', 'TeX', 'BibTeX',
  'Prisma', 'Jupyter Notebook', 'Other',
]);

const SHEBANG_LANG: [RegExp, string][] = [
  [/\b(?:ba|z|k|a)?sh\b/, 'Shell'],
  [/\bfish\b/, 'Fish'],
  [/\bpython[0-9.]*\b/, 'Python'],
  [/\bnode\b/, 'JavaScript'],
  [/\bruby\b/, 'Ruby'],
  [/\bperl\b/, 'Perl'],
  [/\blua\b/, 'Lua'],
  [/\bphp\b/, 'PHP'],
  [/\bRscript\b/, 'R'],
  [/\bdeno\b/, 'TypeScript'],
];

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Best-effort language for a path. Returns "Other" when unknown — unknown files
 * are still counted (blank vs non-blank) as long as they sniff as text.
 */
export function detectLanguage(path: string): string {
  const name = basename(path).toLowerCase();

  const byName = FILENAME_LANG[name];
  if (byName) return byName;

  // Dockerfile.prod, Makefile.local, .eslintrc.json, etc.
  if (name.startsWith('dockerfile.')) return 'Dockerfile';
  if (name.startsWith('makefile.')) return 'Makefile';
  if (name.startsWith('.env.')) return 'Dotenv';

  const ext = extensionOf(path);
  if (ext) {
    const byExt = EXT_LANG[ext];
    if (byExt) return byExt;
    // Two-part extensions: foo.d.ts, foo.spec.tsx, foo.config.js already covered
    // by the last segment. Handle .in / .tmpl / .tpl by stripping the suffix.
    if (ext === 'in' || ext === 'tmpl' || ext === 'tpl' || ext === 'template') {
      const inner = extensionOf(name.slice(0, name.length - ext.length - 1));
      const nested = EXT_LANG[inner];
      if (nested) return nested;
    }
  }
  return 'Other';
}

/** Refine detection using the first line (shebang / modeline). */
export function refineWithContent(language: string, firstLine: string): string {
  if (language !== 'Other' && language !== 'Text') return language;
  if (!firstLine.startsWith('#!')) return language;
  for (const [re, lang] of SHEBANG_LANG) {
    if (re.test(firstLine)) return lang;
  }
  return 'Shell';
}

export function syntaxFor(language: string): Syntax | undefined {
  return SYNTAX[language];
}

export function hasCommentRules(language: string): boolean {
  return SYNTAX[language] !== undefined;
}
