# Auditoría de publicación MCN — 2026-10-20

Código funcional: `0bed8757e2bd6721474b3ae078cd9a63a2104208`, backend 5.00.300. Procedimientos de migración/verificación y este informe se guardan en un commit de auditoría local posterior para no provocar otro reinicio automático de producción por documentación.

Verificación previa: host AWS `ip-172-26-0-152`, MongoDB autoritativo `Cluster0`. Configuración MCN preservada: `Precio_Lp1`, ARS, sin listas adicionales. Cambiados únicamente URL del catálogo y acción `consulta_articulos`/URL legacy asociada; respaldo privado en `settings/migration:MCN:catalog-sql:20261020`. Nunca imprimir su contenido ni incluir credenciales en el informe.

Los servicios dedicados AWS y Mecan contienen el adaptador y redirigen `/qr/MCN` al HTTPS central. Mecan `web-msm`, DB `asisto_turnero`, sin configuración local de catálogo: no se creó una copia artificial. Los archivos de cola, servidor, scanner y permisos instalados se preservaron mediante comparación binaria antes de activar.

Pruebas:

- 42 pruebas focalizadas locales aprobadas antes del ajuste de errores del asistente; 26 de catálogo/errores aprobadas después.
- WebKit worker/main-thread y Chromium nativo simulado en integración: navegación de barras correcta, cero llamadas a foto/IA. No representan teléfonos físicos ni latencia nativa real.
- Manager real, usando el código final de catálogo sin modelo: SKU y BARRA resuelven PROM-52G, LP1 101519; búsqueda por descripción devuelve cuatro resultados seleccionados; similares excluye el original y comienza con BP-M52CC.
- Endpoint público tras migración: SKU HTTP200 en 555 ms, barra HTTP200 en 34 ms (caché), inexistente HTTP404 en 409 ms, barra duplicada HTTP409 en 158 ms. Son muestras puntuales, no benchmark. Acción del asesor HTTP200 con 50 filas. Se reutilizó un identificador de evento existente de forma idempotente; su documento quedó idéntico. Ninguna llamada de IA.
- Red interna: tótem, displays y panel HTTP200 en 172.25.168.99 y 192.168.0.79. Desde el dominio público las pantallas operativas conservan HTTP302 a login. Scanner interno redirige a HTTPS público.
- La suite integral local tuvo un fallo de infraestructura de MongoMemoryServer (inicio excedió 10 s) y sus fallos derivados en el archivo de cola; no se informa como aprobada. Las suites integrales del servidor Linux son las verificaciones de publicación.

Incidencias de publicación:

1. Corte temporal de acceso remoto por cambio de proveedor de Internet en Mecan, informado por el usuario. Recuperado, sin modificar red ni autenticación.
2. JSON textual no decodificado por Axios en solicitudes del catálogo: la primera comprobación pública lo detectó. Se revirtió transitoriamente la configuración al endpoint anterior, se agregó prueba de regresión y se verificó contra Manager antes de activar nuevamente.
3. Consulta de Mostrar más info a las 16:34:59 ART coincidió con reinicio de AWS iniciado a las 16:34:53. Nginx registró conexión rechazada al origen. Se agregó mensaje amigable en español, controles reintentables y ninguna repetición automática del POST de IA. No se hizo una llamada de IA real para reproducirlo; prueba de interfaz con respuesta 520 interceptada.

El nuevo endpoint redondea LP1: PROM-52G fue 101518,56 en la API anterior y 101519 en la nueva. Se conserva la lista; no se recalculan importes en Asisto.

Releases finales comprobados:

- AWS principal: `/opt/asisto/releases/0bed8757e2bd-auto-787MiNOW`, `asisto-production`, `/healthz` saludable. Auto-publicación final 16:42:19 ART. Suite Linux: 417 pruebas, 416 aprobadas, una omitida por plataforma, cero fallos.
- Turnero AWS: `/opt/asisto/turnero/releases/v5.00.270-catalog-sql-0bed8757e2bd`, `asisto-turnero` saludable.
- Mecan: `/opt/asisto/turnero-local/releases/v5.00.270-catalog-sql-0bed8757e2bd`, `asisto-turnero-local` saludable. Checksums del adaptador y ficha coinciden con el paquete; cola y servidor operativo idénticos al release previo.

Verificación final con configuración nueva y último backend: SKU 200/193 ms, barras 200/50 ms, inexistente 404/220 ms, barra duplicada 409/113 ms; LP1 preservada. Acción HTTP del asesor devuelve 50 filas; documento de monetización reutilizado sin alteraciones. Cero IA en las pruebas.

Prueba browser contra HTML público final: Cloudflare 520 interceptado sólo en el navegador; muestra español amigable, no imprime Cloudflare ni texto técnico, habilita Mostrar más info y Enviar y realiza un único POST. Sin IA ni consultas comerciales reales en esa prueba.
