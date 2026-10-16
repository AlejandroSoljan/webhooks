# Lector local de códigos — 2026-10-16

El escaneo automático no requiere IA, subida de fotografías ni claves de terceros. La página usa el lector nativo `BarcodeDetector` cuando funciona. Si falta o no detecta nada tras cinco segundos, carga ZXing 0.21.3 desde el mismo origen y decodifica cuadros localmente. Los formatos habilitados son EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF, Codabar y QR.

El respaldo usa un Web Worker para no bloquear la pantalla; si el navegador impide workers, utiliza el mismo lector local en el hilo principal. Se limita el procesamiento local a un cuadro cada 250 ms como mínimo, sin superponer decodificaciones. Alterna un recorte central y el cuadro completo, a un máximo de 1280 píxeles de ancho, e intenta ambas orientaciones. Se necesitan dos lecturas iguales separadas al menos 80 ms; se mantiene el código como texto. UPC-A utiliza su representación estándar de 12 dígitos, equivalente a EAN-13 con un cero prefijado.

Cerrar, volver a escanear, cambiar a foto o abandonar la página detiene los tracks, worker y lecturas pendientes. Se descartan respuestas tardías, incluso si el permiso de cámara se resolvió después de cerrar.

Assets públicos de sólo lectura:

- `GET /api/ext/qr/scanner-assets/worker-v1.js`: worker del lector, MIME JavaScript, cache de un día.
- `GET /api/ext/qr/scanner-assets/zxing-0.21.3.min.js`: librería vendorizada y fijada por versión y SHA-256; licencia Apache 2.0 bajo `static/qr-scanner/`.

La ficha y API de precio conservan sus contratos. Ingresar un código manualmente sigue funcionando. La opción explícita de sacar una foto al producto sigue usando `/api/ext/qr/photo` y su reconocimiento existente; no se confunde con el escaneo automático.

El nodo local de Mecan sólo ejecuta el turnero, no el catálogo central. Se monta allí la ruta del lector y los assets; el enlace local `/qr/:tenant` redirige al producto público HTTPS para habilitar la cámara. Conserva `scan`, `codigo` y otros parámetros, y no redirige las páginas de operación del turnero. No usa Host ni una URL de destino proporcionada por el cliente.

Pruebas: píxeles reales EAN/UPC/Code128/QR; códigos rotados, ceros, cuadros vacíos; worker real y fallback; cámara Android nativa, iPhone sin lector nativo, excepciones nativas, cierres y resultados tardíos; integración de navegador WebKit y Chromium con cámara sintética, sin usar IA. No equivale a una medición de velocidad en un iPhone físico.
