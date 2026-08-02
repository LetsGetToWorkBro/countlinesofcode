/**
 * Counter version. Bump this whenever the counting algorithm, the ignore rules
 * or the language table change in a way that alters results — it is part of the
 * cache key, so bumping it transparently invalidates every cached count.
 */
export const COUNTER_VERSION = '1.1.0';
