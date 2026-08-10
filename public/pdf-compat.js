/* 1999.LOC browser-compatibility shim. Vanilla JS, no build step.
 *
 * One job: teach ReadableStream how to be async-iterated where the browser has
 * not learned it yet.
 *
 * pdf.js 6 (and mediabunny) read their streams with `for await (const chunk of
 * stream)`. That syntax calls `stream[Symbol.asyncIterator]()`. Chromium and
 * Firefox have shipped it for years; Safari only added async iteration of a
 * ReadableStream in 18.4. In the window between Safari 17.4 (which added
 * Promise.withResolvers, so pdf.js starts up happily) and 18.4, the engine
 * loads, then dies on the first page it reads with:
 *
 *     undefined is not a function (near '...t of e...')
 *
 * which is `for await (const t of e)` finding no iterator on the stream. This
 * installs the standard iterator so those Safari versions work like everything
 * else. Where the browser already has it, this does nothing.
 */
(function () {
  'use strict';
  if (typeof ReadableStream === 'undefined') return;
  var proto = ReadableStream.prototype;
  if (typeof proto[Symbol.asyncIterator] === 'function') return;

  function iterator(stream, preventCancel) {
    var reader = stream.getReader();
    var iter = {
      next: function () {
        return reader.read().then(
          function (result) {
            if (result.done) reader.releaseLock();
            return result;
          },
          function (err) {
            reader.releaseLock();
            throw err;
          },
        );
      },
      'return': function (value) {
        if (preventCancel) {
          reader.releaseLock();
          return Promise.resolve({ done: true, value: value });
        }
        var cancelled = reader.cancel(value);
        reader.releaseLock();
        return cancelled.then(function () { return { done: true, value: value }; });
      },
    };
    iter[Symbol.asyncIterator] = function () { return this; };
    return iter;
  }

  proto.values = function (options) {
    return iterator(this, Boolean(options && options.preventCancel));
  };
  proto[Symbol.asyncIterator] = proto.values;
})();
