/**
 * Browser stand-in for Node's `assert`, for bundling monero-ts.
 *
 * The library uses assert as a real runtime guard (argument checks in its
 * model classes), so this cannot be an empty stub: a failed assertion must
 * throw, or a malformed value would sail through the checks the library
 * relies on. Only the calls monero-ts actually makes are implemented.
 */
function assert(value, message) {
  if (!value) throw new Error(message || 'Assertion failed');
}
assert.equal = function equal(a, b, message) {
  if (a != b) throw new Error(message || 'Expected ' + a + ' == ' + b);
};
assert.notEqual = function notEqual(a, b, message) {
  if (a == b) throw new Error(message || 'Expected ' + a + ' != ' + b);
};
assert.deepEqual = function deepEqual(a, b, message) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message || 'Expected deep equality');
};
assert.ok = assert;
export default assert;
export { assert };
