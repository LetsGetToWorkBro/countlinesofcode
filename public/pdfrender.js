/* LOC.1999 shared PDF renderer. Vanilla JS, no build step.
 *
 * The unlock and shrink tools both do the same core thing: open a PDF with
 * pdf.js (which decrypts a restricted file to render it), turn each page into
 * an image, and read the text off it so a selectable layer can be laid back on
 * top. This is that shared machinery. The two pages differ only in the scale
 * and quality they ask for and in what they do with the result.
 *
 * Both engines are served from this origin — pdf.js to render, pdf-lib (via
 * /pdfsign.js) to write — because the security policy forbids third-party
 * scripts. Nothing is uploaded; there is no fetch() to any endpoint.
 */
(function () {
  'use strict';

  var pdfjs = null;
  var loading = null;

  function loadEngines(onStatus) {
    if (pdfjs && window.LOC1999_SIGN) return Promise.resolve();
    if (loading) return loading;
    if (onStatus) onStatus('Loading the PDF engines (about 700 KB, once)…');
    loading = Promise.all([
      import('/vendor/pdf.min.mjs').then(function (mod) {
        pdfjs = mod;
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      }),
      new Promise(function (resolve, reject) {
        if (window.LOC1999_SIGN) return resolve();
        var s = document.createElement('script');
        s.src = '/pdfsign.js';
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Could not load the PDF writer.')); };
        document.head.appendChild(s);
      }),
    ]).then(function () { if (onStatus) onStatus(''); }, function (err) { loading = null; throw err; });
    return loading;
  }

  /** Open a document, decrypting with a password if one is supplied. */
  function open(bytes, options) {
    options = options || {};
    return pdfjs.getDocument({
      data: bytes.slice(),
      password: options.password || '',
      standardFontDataUrl: '/vendor/standard_fonts/',
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
    }).promise;
  }

  /**
   * Render one page to an image, and collect its text with positions.
   *
   * `scale` trades sharpness against size. `mime`/`quality` pick the encoding.
   * `withText` decides whether to gather the selectable layer — off for a scan
   * that has no real text to recover.
   */
  function renderPage(doc, index, options) {
    return doc.getPage(index + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var viewport = page.getViewport({ scale: options.scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var ctx = canvas.getContext('2d');
      // A white backing: a page with no background is transparent, and JPEG has
      // no transparency, so without this it would come out black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var wordsPromise = options.withText
        ? page.getTextContent().then(function (content) {
            var words = [];
            content.items.forEach(function (item) {
              if (!item.str || !item.str.trim()) return;
              var t = item.transform;
              words.push({ str: item.str, x: t[4], y: t[5], size: Math.hypot(t[2], t[3]) || item.height || 8 });
            });
            return words;
          })
        : Promise.resolve([]);

      return page.render({ canvasContext: ctx, viewport: viewport }).promise
        .then(function () { return wordsPromise; })
        .then(function (words) {
          return new Promise(function (resolve) {
            canvas.toBlob(function (blob) {
              blob.arrayBuffer().then(function (buf) {
                var img = { width: base.width, height: base.height, words: words };
                if (options.mime === 'image/png') img.png = new Uint8Array(buf);
                else img.jpeg = new Uint8Array(buf);
                resolve(img);
              });
            }, options.mime || 'image/jpeg', options.quality);
          });
        });
    });
  }

  window.LOC1999_RENDER = {
    loadEngines: loadEngines,
    open: open,
    renderPage: renderPage,
    pdfjs: function () { return pdfjs; },
  };
})();
