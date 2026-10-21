// Asisto | Camera lifecycle embedded in the product page | 2026-10-16
function stopScanner(hide = true) {
  scanGeneration++;
  if (scanFrame) cancelAnimationFrame(scanFrame);
  scanFrame = 0;
  if (scanLookupTimer) clearTimeout(scanLookupTimer);
  scanLookupTimer = null;
  scanLocalDetector?.close(); scanLocalDetector = null;
  scanTrack = null; torchOn = false;
  if (scanStream) { for (const track of scanStream.getTracks()) track.stop(); scanStream = null; }
  el('scanBtn').classList.remove('hidden');
  el('zoomLabel').classList.add('hidden'); el('torchBtn').classList.add('hidden');
  if (hide) el('scanner').classList.add('hidden');
}
async function startScanner() {
  stopScanner(false); const generation = scanGeneration;
  el('scanner').classList.remove('photoMode'); el('scanBtn').classList.add('hidden');
  const status = el('scanStatus'), video = el('scanVideo');
  el('scanner').classList.remove('hidden'); video.classList.remove('hidden');
  scanCandidate = ''; scanHits = 0; scanCandidateAt = 0;
  status.textContent = 'Alineá el código dentro del recuadro.';
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'La cámara no está disponible en este navegador. Ingresá el código manualmente.';
    el('scanBtn').classList.remove('hidden'); return;
  }
  try {
    let detector = null;
    try {
      if ('BarcodeDetector' in window) {
        const supported = await BarcodeDetector.getSupportedFormats();
        const wanted = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'].filter(x => supported.includes(x));
        if (wanted.length) detector = new BarcodeDetector({ formats: wanted });
      }
    } catch { /* An unusable native decoder falls back to the local reader. */ }
    if (generation !== scanGeneration) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    if (generation !== scanGeneration) { stream.getTracks().forEach(t => t.stop()); return; }
    scanStream = stream; scanTrack = stream.getVideoTracks()[0] || null;
    await configureScannerTrack(); if (generation !== scanGeneration) return;
    video.srcObject = stream; await video.play(); if (generation !== scanGeneration) return;
    const began = Date.now(); let lastLocalFrame = -Infinity;
    if (!detector) status.textContent = 'Alineá el código y mantené el celular quieto. La lectura se realiza en este celular.';
    const detect = async () => {
      if (!scanStream || generation !== scanGeneration) return;
      try {
        let found = [], decodedFrame = false;
        if (detector) { try { found = await detector.detect(video); } catch {} decodedFrame = true; }
        if (generation !== scanGeneration) return;
        if (!found.length && scanLocalDetector) decodedFrame = false;
        if (!found.length && (!detector || Date.now() - began >= 5000) && Date.now() - lastLocalFrame >= 250) {
          lastLocalFrame = Date.now();
          if (!scanLocalDetector) {
            const local = await createLocalBarcodeDetector();
            if (generation !== scanGeneration) { local.close(); return; }
            scanLocalDetector = local;
          }
          found = await scanLocalDetector.detect(video); decodedFrame = true;
        }
        if (generation !== scanGeneration || !scanStream) return;
        const code = normalizedCode(found[0]?.rawValue);
        if (code) {
          if (code === scanCandidate) scanHits++;
          else { scanCandidate = code; scanHits = 1; scanCandidateAt = Date.now(); }
          status.textContent = 'Leyendo: ' + code;
          if (scanHits >= 2 && Date.now() - scanCandidateAt >= 80) {
            el('codeInput').value = code; stopScanner(false); video.classList.add('hidden');
            status.textContent = 'Código detectado: ' + code + '. Buscando producto…';
            scanLookupTimer = setTimeout(() => openCode(code, 'scan'), 200); return;
          }
        } else if (decodedFrame) { scanCandidate = ''; scanHits = 0; }
      } catch {
        if (generation === scanGeneration) {
          status.textContent = 'No se pudo iniciar el lector local. Podés reabrir la cámara o ingresar el código manualmente.';
          stopScanner(false); return;
        }
      }
      if (generation === scanGeneration && scanStream) scanFrame = requestAnimationFrame(detect);
    };
    detect();
  } catch {
    if (generation !== scanGeneration) return;
    stopScanner(false); video.classList.add('hidden');
    status.textContent = 'No se pudo abrir la cámara. Podés ingresar el código manualmente.';
  }
}
module.exports = { stopScanner, startScanner };
