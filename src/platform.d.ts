/**
 * The entire platform surface this project depends on.
 *
 * The TypeScript configuration deliberately loads `ES2022` and nothing else:
 * no DOM library. That is not fussiness. The vault target has no window, no
 * document, no fetch and no storage, and a compiler that knows about them will
 * happily accept the day somebody reaches for one. Keeping the ambient
 * environment this small means "there is no network code in the vault" is
 * something the build checks rather than something a README claims.
 *
 * So anything genuinely needed from outside the language has to be written
 * down here, and the list being short is the point. If this file grows, the
 * property it protects is shrinking, and that is worth an argument rather than
 * an import.
 *
 * `TextEncoder` and `TextDecoder` are WHATWG Encoding, not DOM: present in
 * Node, in every browser, and in Hermes. Older React Native runtimes need a
 * polyfill for them, which is a real deployment note rather than a detail, and
 * it is here because that is where somebody will look for it.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}
