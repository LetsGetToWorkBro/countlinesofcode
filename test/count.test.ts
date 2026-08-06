import { describe, expect, it } from 'vitest';
import { Aggregator, countFile, countLines } from '../src/lib/count';
import { detectLanguage } from '../src/lib/languages';

/** Every classification must partition the file exactly. */
function expectCounts(
  text: string,
  language: string,
  expected: { lines: number; code: number; comment: number; blank: number },
): void {
  const actual = countLines(text, language);
  expect(actual).toEqual(expected);
  expect(actual.code + actual.comment + actual.blank).toBe(actual.lines);
}

describe('countLines - basics', () => {
  it('counts an empty file as nothing', () => {
    expectCounts('', 'JavaScript', { lines: 0, code: 0, comment: 0, blank: 0 });
  });

  it('counts a file with no trailing newline', () => {
    expectCounts('let a = 1;', 'JavaScript', { lines: 1, code: 1, comment: 0, blank: 0 });
  });

  it('does not invent a line after a trailing newline', () => {
    expectCounts('let a = 1;\n', 'JavaScript', { lines: 1, code: 1, comment: 0, blank: 0 });
  });

  it('treats CRLF line endings the same as LF', () => {
    expectCounts('a();\r\n\r\n// x\r\n', 'JavaScript', { lines: 3, code: 1, comment: 1, blank: 1 });
  });

  it('ignores a UTF-8 BOM', () => {
    expectCounts('﻿// hello\n', 'JavaScript', { lines: 1, code: 0, comment: 1, blank: 0 });
  });

  it('counts whitespace-only lines as blank', () => {
    expectCounts('a();\n   \n\t\n', 'JavaScript', { lines: 3, code: 1, comment: 0, blank: 2 });
  });
});

describe('countLines - C family', () => {
  it('separates code, line comments and blanks', () => {
    // The trailing '' makes the file end with a newline; it is not a 6th line.
    const src = ['// header', '', 'int main() {', '  return 0; // done', '}', ''].join('\n');
    expectCounts(src, 'C', { lines: 5, code: 3, comment: 1, blank: 1 });
  });

  it('handles block comments spanning lines, blanks inside stay blank', () => {
    const src = ['/*', ' * doc', '', ' */', 'x();'].join('\n');
    expectCounts(src, 'C', { lines: 5, code: 1, comment: 3, blank: 1 });
  });

  it('does not treat // inside a string as a comment', () => {
    expectCounts('const u = "http://example.com";\n', 'JavaScript', {
      lines: 1,
      code: 1,
      comment: 0,
      blank: 0,
    });
  });

  it('does not treat /* inside a string as a comment', () => {
    const src = 'const s = "/* not a comment";\nreal();\n';
    expectCounts(src, 'JavaScript', { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('counts a trailing block comment start as code on that line', () => {
    const src = 'x(); /* start\nstill comment */\n';
    expectCounts(src, 'JavaScript', { lines: 2, code: 1, comment: 1, blank: 0 });
  });

  it('handles escaped quotes inside strings', () => {
    expectCounts('const s = "a \\" // b";\n', 'JavaScript', { lines: 1, code: 1, comment: 0, blank: 0 });
  });

  it('handles multi-line template literals', () => {
    const src = ['const s = `', '// not a comment', '`;', '// real'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 4, code: 3, comment: 1, blank: 0 });
  });

  it('does not let a regex literal containing /* open a block comment', () => {
    // Real case from source-map/lib/util.js, which cloc also gets wrong.
    const src = ['if (root.match(/^([^\\/]+:\\/)?\\/*$/)) {', '  return path;', '}'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('does not let a regex literal containing // open a line comment', () => {
    const src = ['const proto = url.replace(/^https?:\\/\\//, "");', 'next();'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('still treats /* as a comment where a regex would also be legal', () => {
    const src = ['const a = /* block', 'comment only', '*/ 5;'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 3, code: 2, comment: 1, blank: 0 });
  });

  it('treats division as division, not as a regex', () => {
    // If `/ count;` were read as a regex it would swallow the `/*`, and the
    // block comment on line 2 would be counted as code.
    const src = ['const ratio = total / count; /* trailing', 'still comment */', 'done();'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 3, code: 2, comment: 1, blank: 0 });
  });

  it('allows a regex after a keyword', () => {
    const src = ['function f(s) {', '  return /a\\/b/.test(s); // ok', '}'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('handles a slash inside a regex character class', () => {
    expectCounts('const re = /[a/b]+/g;\n', 'JavaScript', { lines: 1, code: 1, comment: 0, blank: 0 });
  });

  it('does not read a closing HTML tag as a regex', () => {
    // `</p>` after `<` used to start a "regex" that ate the rest of the line,
    // including the backtick that closed the template literal.
    const src = [
      'const html = `<p>${x}</p>`;',
      '// a real comment',
      'done();',
    ].join('\n');
    expectCounts(src, 'TypeScript', { lines: 3, code: 2, comment: 1, blank: 0 });
  });

  it('handles template literals nested inside ${ } interpolation', () => {
    const src = [
      'const out = `${hint ? `<p>${esc(hint)}</p>` : \'\'}',
      'tail`;',
      '// still a comment',
    ].join('\n');
    expectCounts(src, 'TypeScript', { lines: 3, code: 2, comment: 1, blank: 0 });
  });

  it('keeps brace depth inside an interpolation', () => {
    const src = ['const a = `${ obj.map(x => ({ k: x })) }`;', '// comment'].join('\n');
    expectCounts(src, 'TypeScript', { lines: 2, code: 1, comment: 1, blank: 0 });
  });

  it('allows a regex directly after an arrow', () => {
    const src = ['const hits = xs.filter(x => /a\\/b/.test(x));', '// comment'].join('\n');
    expectCounts(src, 'JavaScript', { lines: 2, code: 1, comment: 1, blank: 0 });
  });

  it('does not apply regex rules to languages without regex literals', () => {
    // Go: `/` is always division, so `/*` after `=` is a block comment.
    const src = ['x := a / b', 'y := /* note */ 2'].join('\n');
    expectCounts(src, 'Go', { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('does not nest C block comments', () => {
    const src = '/* a /* b */\ncode();\n';
    expectCounts(src, 'C', { lines: 2, code: 1, comment: 1, blank: 0 });
  });
});

describe('countLines - nesting languages', () => {
  it('nests Rust block comments', () => {
    const src = ['/* outer', '  /* inner */', '  still comment', '*/', 'fn main() {}'].join('\n');
    expectCounts(src, 'Rust', { lines: 5, code: 1, comment: 4, blank: 0 });
  });

  it('nests Haskell block comments', () => {
    const src = ['{- a {- b -} c -}', 'main = print 1'].join('\n');
    expectCounts(src, 'Haskell', { lines: 2, code: 1, comment: 1, blank: 0 });
  });
});

describe('countLines - Python', () => {
  it('treats a leading triple-quoted string as a comment', () => {
    const src = ['"""', 'Module docs.', '"""', '', 'import os', 'x = 1  # trailing'].join('\n');
    expectCounts(src, 'Python', { lines: 6, code: 2, comment: 3, blank: 1 });
  });

  it('treats a mid-expression triple-quoted string as code', () => {
    const src = ['x = """', 'body', '"""', 'y = 2'].join('\n');
    expectCounts(src, 'Python', { lines: 4, code: 4, comment: 0, blank: 0 });
  });

  it('does not treat # inside a string as a comment', () => {
    expectCounts('color = "#ff0000"\n', 'Python', { lines: 1, code: 1, comment: 0, blank: 0 });
  });

  it('counts a shebang as a comment', () => {
    expectCounts('#!/usr/bin/env python\nprint(1)\n', 'Python', {
      lines: 2,
      code: 1,
      comment: 1,
      blank: 0,
    });
  });
});

describe('countLines - other language families', () => {
  it('handles Ruby =begin/=end only at column zero', () => {
    const src = ['=begin', 'docs', '=end', 'puts 1'].join('\n');
    expectCounts(src, 'Ruby', { lines: 4, code: 1, comment: 3, blank: 0 });
  });

  it('does not treat an indented =begin as a comment', () => {
    const src = ['  =begin', 'puts 1'].join('\n');
    expectCounts(src, 'Ruby', { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('prefers Lua long comments over line comments', () => {
    const src = ['--[[', 'block', ']]', '-- line', 'print(1)'].join('\n');
    expectCounts(src, 'Lua', { lines: 5, code: 1, comment: 4, blank: 0 });
  });

  it('handles shell comments and strings', () => {
    const src = ['#!/bin/sh', '# comment', 'echo "# not a comment"', ''].join('\n');
    expectCounts(src, 'Shell', { lines: 3, code: 1, comment: 2, blank: 0 });
  });

  it('handles SQL double-dash comments', () => {
    expectCounts('SELECT 1; -- pick one\n-- all comment\n', 'SQL', {
      lines: 2,
      code: 1,
      comment: 1,
      blank: 0,
    });
  });

  it('handles CSS block comments', () => {
    const src = ['/* theme */', 'body {', '  color: red;', '}'].join('\n');
    expectCounts(src, 'CSS', { lines: 4, code: 3, comment: 1, blank: 0 });
  });

  it('handles Go with backticked raw strings', () => {
    const src = ['// pkg', 'var s = `', '// inside raw string', '`'].join('\n');
    expectCounts(src, 'Go', { lines: 4, code: 3, comment: 1, blank: 0 });
  });

  it('handles PHP hash and slash comments', () => {
    const src = ['<?php', '# one', '// two', '/* three */', 'echo 1;'].join('\n');
    expectCounts(src, 'PHP', { lines: 5, code: 2, comment: 3, blank: 0 });
  });
});

describe('countLines - HTML with embedded script and style', () => {
  it('applies JS rules inside <script> and CSS rules inside <style>', () => {
    const src = [
      '<!-- page -->',
      '<html>',
      '<style>',
      '/* css comment */',
      'body { color: red }',
      '</style>',
      '<script>',
      '// js comment',
      'var x = 1;',
      '</script>',
      '</html>',
    ].join('\n');
    expectCounts(src, 'HTML', { lines: 11, code: 8, comment: 3, blank: 0 });
  });

  it('handles a script tag with attributes', () => {
    const src = ['<script type="module">', '// comment', '</script>'].join('\n');
    expectCounts(src, 'HTML', { lines: 3, code: 2, comment: 1, blank: 0 });
  });
});

describe('countLines - languages without rules', () => {
  it('counts JSON as blank vs non-blank', () => {
    expectCounts('{\n  "a": 1\n}\n\n', 'JSON', { lines: 4, code: 3, comment: 0, blank: 1 });
  });
});

describe('countFile', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('detects the language from the path', () => {
    const result = countFile('src/index.ts', enc('// x\nconst a = 1;\n'));
    expect(result.language).toBe('TypeScript');
    expect(result.counts).toEqual({ lines: 2, code: 1, comment: 1, blank: 0 });
  });

  it('detects shebang languages for extensionless files', () => {
    const result = countFile('bin/tool', enc('#!/usr/bin/env bash\n# hi\nls\n'));
    expect(result.language).toBe('Shell');
    expect(result.counts.comment).toBe(2);
  });

  it('reports byte length, not character length', () => {
    const result = countFile('a.txt', enc('héllo\n'));
    expect(result.bytes).toBe(7);
  });
});

describe('detectLanguage', () => {
  const cases: [string, string][] = [
    ['a/b/Main.java', 'Java'],
    ['Dockerfile', 'Dockerfile'],
    ['Dockerfile.prod', 'Dockerfile'],
    ['Makefile', 'Makefile'],
    ['CMakeLists.txt', 'CMake'],
    ['Gemfile', 'Ruby'],
    ['x/Jenkinsfile', 'Groovy'],
    ['component.tsx', 'TSX'],
    ['styles/app.scss', 'SCSS'],
    ['config.yml', 'YAML'],
    ['weird.zzz', 'Other'],
    ['.gitignore', 'Ignore List'],
    ['script.sh.in', 'Shell'],
  ];
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected}`, () => {
      expect(detectLanguage(path)).toBe(expected);
    });
  }
});

describe('Aggregator', () => {
  it('rolls up totals and sorts languages by code', () => {
    const agg = new Aggregator();
    agg.add('a.ts', 'TypeScript', 100, { lines: 10, code: 7, comment: 2, blank: 1 });
    agg.add('b.ts', 'TypeScript', 50, { lines: 5, code: 4, comment: 0, blank: 1 });
    agg.add('c.json', 'JSON', 20, { lines: 30, code: 30, comment: 0, blank: 0 });

    expect(agg.totals).toEqual({ files: 3, bytes: 170, lines: 45, code: 41, comment: 2, blank: 2 });

    const languages = agg.languages();
    expect(languages.map((l) => l.language)).toEqual(['JSON', 'TypeScript']);
    expect(languages[0]!.files).toBe(1);
    expect(languages[1]!.code).toBe(11);
    expect([...agg.languagesWithoutCommentRules]).toEqual(['JSON']);
  });

  it('tracks the biggest files by line count', () => {
    const agg = new Aggregator();
    for (let i = 0; i < 20; i++) {
      agg.add(`f${i}.ts`, 'TypeScript', 1, { lines: i, code: i, comment: 0, blank: 0 });
    }
    const biggest = agg.biggestFiles();
    expect(biggest).toHaveLength(10);
    expect(biggest[0]).toEqual({ path: 'f19.ts', lines: 19, language: 'TypeScript' });
    expect(biggest[9]!.lines).toBe(10);
  });
});

describe('countLines - multiline strings do not open runaway comments', () => {
  it('Rust: a /* inside a multiline string literal is not a comment', () => {
    // The runaway-comment finding: the string spans a newline, and the /*
    // inside it must not be read as the start of a block comment.
    expectCounts('let s = "line1\n/* line2";\nfn f() {}\n', 'Rust',
      { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('Rust: a raw string r#"..."# is consumed whole', () => {
    expectCounts('let s = r#"a /* b"#;\nfn f() {}\n', 'Rust',
      { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('Rust: a raw string with two hashes holds a "# without closing early', () => {
    // r##"has "# here"## contains a literal "#, which the single-hash spec would
    // have closed on, spilling the rest of the line into a runaway multiline
    // string. The two-hash spec closes only on "##.
    expectCounts('let s = r##"has "# /* x"##;\nfn f() {}\n', 'Rust',
      { lines: 2, code: 2, comment: 0, blank: 0 });
  });

  it('Rust: a three-hash raw string spanning lines is not a comment', () => {
    expectCounts('let s = r###"a\n/* b "## c\n"###;\nfn f() {}\n', 'Rust',
      { lines: 4, code: 4, comment: 0, blank: 0 });
  });

  it('Kotlin: a /* inside a triple-quoted string is not a comment', () => {
    expectCounts('val q = """\na /* b\nc\n"""\nfun main() {}\n', 'Kotlin',
      { lines: 5, code: 5, comment: 0, blank: 0 });
  });

  it('Kotlin: a // inside a triple-quoted string is not a comment', () => {
    expectCounts('val q = """\n// hello\n"""\n', 'Kotlin',
      { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('Scala, Swift, Groovy: triple-quoted strings behave the same', () => {
    for (const lang of ['Scala', 'Swift', 'Groovy']) {
      expectCounts('val q = """\na /* b\n"""\ncode\n', lang,
        { lines: 4, code: 4, comment: 0, blank: 0 });
    }
  });

  it('Dart: a triple-single-quoted string is consumed whole', () => {
    expectCounts("var q = '''\na /* b\n''';\nvoid main() {}\n", 'Dart',
      { lines: 4, code: 4, comment: 0, blank: 0 });
  });

  it('C#: a verbatim string @"..." spanning lines is not a comment', () => {
    expectCounts('var s = @"a\n/* b";\nvoid M() {}\n', 'C#',
      { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('C#: still reads an ordinary // comment', () => {
    expectCounts('int x = 1; // note\n', 'C#', { lines: 1, code: 1, comment: 0, blank: 0 });
  });
});

describe('countLines - MATLAB block comments', () => {
  it('treats an inline %{ as an ordinary comment to end of line, not a runaway block', () => {
    expectCounts('a = 5   %{ inline\nb = 6\nc = 7\n', 'MATLAB',
      { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('does not let %{index} run to the end of the file', () => {
    expectCounts('x = 5;   %{index}\ny = 6;\nz = 7;\n', 'MATLAB',
      { lines: 3, code: 3, comment: 0, blank: 0 });
  });

  it('still honours a real block comment that stands on its own lines', () => {
    expectCounts('%{\nhidden\n%}\nx = 1\n', 'MATLAB',
      { lines: 4, code: 1, comment: 3, blank: 0 });
  });

  it('still reads an ordinary % line comment', () => {
    expectCounts('% just a comment\nx = 1\n', 'MATLAB',
      { lines: 2, code: 1, comment: 1, blank: 0 });
  });

  it('opens an indented block comment (marker need not be at column 0)', () => {
    // A `%{`/`%}` inside a function body is indented; demanding column 0 counted
    // the whole block as code.
    expectCounts('function f()\n    %{\n    hidden\n    %}\n    x = 1;\nend\n', 'MATLAB',
      { lines: 6, code: 3, comment: 3, blank: 0 });
  });

  it('does not open a block when %{ has trailing text on its line', () => {
    // `%{ note` is a line comment, not a block open, so the following lines stay
    // code rather than being swallowed to the next %}.
    expectCounts('%{ note\nx = 1;\ny = 2;\n', 'MATLAB',
      { lines: 3, code: 2, comment: 1, blank: 0 });
  });

  it('does not close a block on a %} that has trailing text', () => {
    // The close must stand alone; `%} tail` keeps the block open, so everything
    // through the real lone %} is comment.
    expectCounts('%{\nhidden\n%} tail\nstill hidden\n%}\nx = 1;\n', 'MATLAB',
      { lines: 6, code: 1, comment: 5, blank: 0 });
  });
});
