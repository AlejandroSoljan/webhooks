# Mecan: instalación desde el QR sin perder el turno

Actualizado: 2026-10-27. Backend 5.00.313; Android Mecan 1.0.1, código 2.

El QR se reclama primero en el navegador y conserva el número, sector y posición del turno. Sólo MCN, navegador Android, un turno WAITING/CALLED vinculado y la variable `MECAN_INSTALL_PROMPT_ENABLED=1` habilitan el modal. No se ofrece en la app, iPhone, otros dominios ni después de finalizar el turno. Cerrar/«Ahora no» conserva el flujo web y evita repetir la invitación para ese turno durante la sesión.

## Contrato API

`POST /api/customer-app/:tenant/tickets/:id/handoff` admite `{installId, purpose:"install"}` y responde `{code, expiresAt}`. Requiere ser dueño del turno activo. Para instalación, el vínculo dura dos horas; si no se envía purpose conserva los tres minutos anteriores. El servidor sólo almacena el hash del código aleatorio de 256 bits. No acepta otro purpose.

El navegador guarda el vínculo antes de abrir Google Play y envía únicamente `mecan_ticket` y `mecan_code` en Install Referrer. El número de teléfono, nombre e identificador del navegador no se envían a Play. El botón «Ya instalé Mecan · Abrir mi turno» se reconstruye al regresar o recargar la web, como alternativa si no se recibe el referrer.

Android consulta Play Install Referrer al primer inicio. Valida id/código, arma exclusivamente la URL HTTPS canónica de MCN y conserva el vínculo pendiente en preferencias privadas hasta que `/claim` responde correctamente y la web confirma el id mediante `completeInstallTicket`. Un enlace explícito entrante tiene prioridad sobre la consulta asíncrona. Error de Play o espera mayor a 3,5 segundos abre el inicio y permite reintentar en el siguiente arranque. No se registran tokens en logs.

`/claim` consume el vínculo manteniendo el mismo documento/número y acceso web anterior; admite reintentos de la misma app y rechaza la repetición desde otro dispositivo. Los turnos finalizados/vencidos no se reactivan. La ventana de instalación no extiende la validez del QR presencial ni el día del turno.

## Activación y operación

1. Publicar y verificar código en backend AWS, turnero AWS y turnero local Mecan. La variable está apagada por defecto hasta verificar la distribución de Android compatible.
2. Incorporar a `/.well-known/assetlinks.json` la huella SHA-256 de **firma de apps de Play** para `ar.com.asisto.mecan`, conservando Scanner. No sustituirla por la clave de carga.
3. Distribuir Android 1.0.1 (2) en Play y comprobar instalación por enlace en un dispositivo real. La existencia del AAB firmado no acredita distribución ni recuperación real.
4. Activar `MECAN_INSTALL_PROMPT_ENABLED=1` en ambos turneros y backend, reiniciar con healthz y comprobar Android web/app. Si la versión compatible sigue en revisión, dejarla apagada.

El script `deploy/mecan-install/patch-runtime.cjs` aplica los puntos de integración sobre una **copia** de cada release existente, valida marcadores únicos y conserva diferencias de operación entre backend y motor local. Copiar también `queue_install.js`. Respaldar el destino del enlace current y revertirlo si falla healthz. Nunca reconstruir la release local copiando todo el backend AWS.

## Verificación

Pruebas DOM: visibilidad, cierre, referrer con el mismo id, almacenamiento anterior a navegación, regreso desde tienda y error de API sin navegación. Integración Mongo aislada: token de instalación más allá del vencimiento del QR inicial, id/número únicos, autorización y rechazo de replay. Android: validación de referrer, sin URLs externas ni parámetros ambiguos; compilar AAB/APK firmado y pruebas JVM. Pendiente siempre documentar la prueba física Play → instalación → mismo turno y aprobación/publicación de Play.
