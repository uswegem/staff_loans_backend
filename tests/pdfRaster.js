'use strict';

// Test helpers for PDFs (D-110): every page's text with positions, and every page drawn to a
// PNG (pdf.js with @napi-rs/canvas, no browser), for the visual regression check.

const { pathToFileURL } = require('url');
const { PNG } = require('pngjs');

const lib = () => import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);

/** [{ items: [{ str, x, y, size }], height }] per page; y from the bottom of the page. */
async function pages(buffer) {
  const pdfjs = await lib();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();
    out.push({ height: page.view[3], items: content.items.filter((it) => it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], size: Math.abs(it.transform[3]) })) });
  }
  await task.destroy();
  return out;
}

/** Every page as a PNG buffer at the given scale. */
async function raster(buffer, scale = 1) {
  const pdfjs = await lib();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvasContext: canvas.context, viewport, canvas: canvas.canvas }).promise;
    out.push(canvas.canvas.toBuffer('image/png'));
  }
  await task.destroy();
  return out;
}

/** Share of pixels that differ by more than a small tolerance (0 to 1); 1 when the sizes differ. */
function diff(a, b, tolerance = 48) {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 1;
  let changed = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
    if (d > tolerance) changed += 1;
  }
  return changed / (x.width * x.height);
}

module.exports = { pages, raster, diff };
