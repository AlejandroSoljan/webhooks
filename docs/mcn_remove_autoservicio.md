# MCN: retiro de Autoservicio — 01/11/2026, backend 5.00.327

Se excluye `autoservicio` de normalizedSectors sólo cuando tenant normalizado es MCN. Funciona con defaults y configuraciones guardadas/antiguas, sin borrar ningún documento ni historial. Conserva demo y otros dominios. Config compartida por tótem, app y selectores; recargar páginas abiertas. No modifica QR de productos, autorización, notificaciones ni emisión de las otras cuatro secciones.

Publicación mediante patch-remove-autoservicio.cjs: sustituye únicamente normalizedSectors en cada release instalado y compara el resto del archivo. update-remove-autoservicio.sh clona release, conserva archivos de colas/estadísticas por comparación binaria, comprueba sintaxis, actualiza enlace atómico y verifica healthz con rollback. No copiar archivos completos de main sobre runtimes personalizados.

Validar AWS principal y dedicado, Mecan, config MCN con cuatro secciones y demo con cinco, acceso público protegido y acceso interno conservado. Pruebas unitarias de defaults, configuración antigua, guardada sin mutación y aislamiento por tenant; regresión de colas/presencia histórica.
