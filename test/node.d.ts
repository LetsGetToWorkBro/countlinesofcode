/**
 * Test-only: the sliver of Node the source guard needs to read the tree.
 *
 * Deliberately not `@types/node`. That package declares `fetch`, `WebSocket`
 * and the rest as globals, which would quietly undo the thing
 * `src/platform.d.ts` exists to enforce: in the vault's source, reaching for
 * the network should not typecheck. Three functions declared here cost less
 * than losing that.
 */

declare module 'node:fs' {
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}
