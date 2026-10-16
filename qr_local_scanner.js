// Asisto | Local barcode decoding; no image uploads or AI | 2026-10-16
const path = require('node:path');
const SCANNER_ASSET_BASE = '/api/ext/qr/scanner-assets/';

function decodeLocalBarcodeFrame(ZXing, rgba, width, height, reader) {
  if (!width || !height || rgba.length !== width * height * 4) return [];
  const pixels = new Int32Array(width * height);
  for (let i = 0, j = 0; i < pixels.length; i++, j += 4) pixels[i] = (rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2];
  const attempt = (data, w, h) => {
    try {
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(data, w, h)));
      return [{ rawValue: reader.decodeWithState(bitmap).getText() }];
    } catch { return []; }
    finally { reader.reset(); }
  };
  const normal = attempt(pixels, width, height);
  if (normal.length) return normal;
  const rotated = new Int32Array(pixels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rotated[x * height + height - 1 - y] = pixels[y * width + x];
  return attempt(rotated, height, width);
}

function localScannerWorker() {
  importScripts('/api/ext/qr/scanner-assets/zxing-0.21.3.min.js');
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.CODABAR, ZXing.BarcodeFormat.QR_CODE]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader(); reader.setHints(hints);
  self.onmessage = event => {
    const { id, buffer, width, height } = event.data;
    const results = decodeLocalBarcodeFrame(ZXing, new Uint8ClampedArray(buffer), width, height, reader);
    self.postMessage({ id, results });
  };
  self.postMessage({ ready: true });
}

// Embedded in the scanner page, loaded only when native decoding is unavailable
// or has not recognized a barcode. All camera pixels remain on the device.
function createLocalBarcodeDetector() {
  const assetBase = '/api/ext/qr/scanner-assets/';
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return Promise.reject(new Error('canvas_unavailable'));
  let worker = null, reader = null, closed = false, pending = null, sequence = 0, frame = 0;
  let initTimer, resolveReady;
  const notFound = () => [];
  const loadLibrary = () => {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (window.asistoZXingLoading) return window.asistoZXingLoading;
    const p = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = assetBase + 'zxing-0.21.3.min.js'; script.async = true;
      const timer = setTimeout(() => { script.remove(); reject(new Error('local_reader_timeout')); }, 12000);
      script.onload = () => { clearTimeout(timer); window.ZXing ? resolve(window.ZXing) : reject(new Error('local_reader_unavailable')); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('local_reader_load_failed')); };
      document.head.append(script);
    });
    window.asistoZXingLoading = p;
    p.catch(() => { if (window.asistoZXingLoading === p) window.asistoZXingLoading = null; });
    return p;
  };
  const startMainThread = async () => {
    const z = await loadLibrary();
    if (closed) throw new Error('scanner_closed');
    const hints = new Map();
    hints.set(z.DecodeHintType.POSSIBLE_FORMATS, [z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8, z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E, z.BarcodeFormat.CODE_128, z.BarcodeFormat.CODE_39, z.BarcodeFormat.ITF, z.BarcodeFormat.CODABAR, z.BarcodeFormat.QR_CODE]);
    hints.set(z.DecodeHintType.TRY_HARDER, true);
    reader = new z.MultiFormatReader(); reader.setHints(hints);
  };
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    if (typeof Worker !== 'function') { startMainThread().then(resolve, reject); return; }
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true; clearTimeout(initTimer); worker?.terminate(); worker = null;
      startMainThread().then(resolve, reject);
    };
    try {
      worker = new Worker(assetBase + 'worker-v1.js');
      initTimer = setTimeout(fallback, 8000);
      worker.onmessage = event => {
        if (event.data.ready) { if (settled) return; settled = true; clearTimeout(initTimer); resolve(); return; }
        if (pending && event.data.id === pending.id) { clearTimeout(pending.timer); const done = pending.resolve; pending = null; done(event.data.results || []); }
      };
      worker.onerror = () => {
        if (!settled) { fallback(); return; }
        if (pending) { clearTimeout(pending.timer); pending.resolve([]); pending = null; }
        worker?.terminate(); worker = null;
        // A later frame can initialize the same local decoder on the main thread.
      };
    } catch { fallback(); }
  });
  const detector = {
    async detect(video) {
      await ready;
      if (closed || pending || !video.videoWidth || !video.videoHeight) return [];
      // Alternate a focused horizontal strip and the entire image (also reads QR).
      const vw = video.videoWidth, vh = video.videoHeight, crop = frame++ % 2 === 0;
      const sh = crop ? Math.max(1, Math.round(vh * .55)) : vh, sy = Math.round((vh - sh) / 2), scale = Math.min(1, 1280 / vw);
      canvas.width = Math.max(1, Math.round(vw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
      context.drawImage(video, 0, sy, vw, sh, 0, 0, canvas.width, canvas.height);
      if (worker) {
        const image = context.getImageData(0, 0, canvas.width, canvas.height), id = ++sequence;
        return new Promise(resolve => {
          const timer = setTimeout(() => { if (pending?.id === id) { pending = null; worker?.terminate(); worker = null; resolve([]); } }, 3000);
          pending = { id, resolve, timer };
          try { worker.postMessage({ id, buffer: image.data.buffer, width: image.width, height: image.height }, [image.data.buffer]); }
          catch { clearTimeout(timer); pending = null; worker?.terminate(); worker = null; resolve([]); }
        });
      }
      if (!reader) await startMainThread();
      if (closed) return [];
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return decodeLocalBarcodeFrame(window.ZXing, image.data, image.width, image.height, reader);
    },
    close() {
      closed = true; clearTimeout(initTimer); worker?.terminate(); worker = null;
      resolveReady?.();
      if (pending) { clearTimeout(pending.timer); pending.resolve([]); pending = null; }
      reader?.reset(); canvas.width = canvas.height = 0;
    },
  };
  // Return immediately so closing the camera can cancel a still-loading worker.
  ready.catch(notFound);
  detector.ready = ready;
  return Promise.resolve(detector);
}

function mountLocalScannerAssets(app) {
  const files = { 'zxing-0.21.3.min.js': path.join(__dirname, 'static/qr-scanner/zxing-0.21.3.min.js') };
  app.get('/api/ext/qr/scanner-assets/:asset', (req, res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.params.asset === 'worker-v1.js') return res.type('application/javascript').send(decodeLocalBarcodeFrame.toString() + '\n(' + localScannerWorker.toString() + ')();');
    const file = files[req.params.asset];
    if (!file) return res.status(404).end();
    res.type('application/javascript').sendFile(file);
  });
}
function mountQueueScannerRedirect(app) {
  mountLocalScannerAssets(app);
  // HTTP intranet pages cannot open an iPhone camera. Product scanning is served
  // by the existing public HTTPS app, without moving the operator/local queue.
  app.get(['/qr/:tenant', '/qr/:tenant/:code'], (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(req.params.tenant)) return res.status(400).end();
    const url = new URL('https://asistobot.com.ar/qr/' + encodeURIComponent(req.params.tenant));
    url.search = new URL(req.originalUrl, 'http://intranet.invalid').search;
    if (req.params.code) url.searchParams.set('codigo', req.params.code);
    res.set('Cache-Control', 'no-store'); res.redirect(302, url.href);
  });
}
module.exports = { createLocalBarcodeDetector, decodeLocalBarcodeFrame, localScannerWorker, mountLocalScannerAssets, mountQueueScannerRedirect, SCANNER_ASSET_BASE };
