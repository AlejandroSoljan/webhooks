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

## Registro de publicación, 2026-10-27

- Código publicado en `main`: `a28aa17490748808171df6914fbfdc6ada772af5`.
- Turnero AWS y turnero local Mecan: release `v5.00.313-mecan-install-20261027`, servicios activos y `/healthz` correcto. Conservan sus diferencias operativas y su release anterior para reversión.
- URL pública MCN comprobada: contiene las funciones de instalación y regreso, con invitación **apagada**. `/.well-known/assetlinks.json` público conserva Scanner e incluye Mecan con sus tres certificados de Play.
- Mecan 1.0.1 (2): AAB firmado aceptado por Play Console y enviado a revisión de producción (100% de los países ya configurados). Console muestra «Cambios en la etapa de revisión», con verificaciones rápidas todavía en curso; esto no acredita aprobación ni disponibilidad en la tienda.
- Resultado local: 43/43 pruebas Node focalizadas, 3/3 pruebas JVM y compilación release firmada. No había teléfono conectado para la prueba física de instalación.
- Pendiente: confirmar release activo del backend principal después de su despliegue automático; aprobación/distribución Play y prueba física antes de activar la invitación. No activar por el solo hecho de terminar la compilación o enviar a revisión.

## Corrección y activación, 2026-10-28

Actualización 2026-10-29: Play confirmó Mecan 1.0.2 disponible. Mecan 1.0.3 (4) incorpora comprobación nativa de nuevas versiones al abrir o volver a la app. Se consulta Play, se ofrece «Actualizar»/«Ahora no» y la descarga flexible no bloquea el turno. «Instalar» completa y reinicia cuando el usuario decide. La actualización conserva almacenamiento existente y no solicita un nuevo turno, no ejecuta desinstalación ni limpieza. Si no hay Play/conexión se continúa normalmente; si no admite modalidad flexible se abre su ficha de tienda. Requiere instalar 1.0.3 una vez desde Play para recibir avisos posteriores. Es un cambio exclusivo del paquete Android, sin código de runtime que desplegar en AWS ni Mecan local, sin cambios Mongo ni versión backend.

Prueba física de futuras actualizaciones: usar una instalación Play 1.0.3 o superior con un turno activo, anotar id/número e identificador de instalación y habilitar una versión mayor en el canal autorizado. Verificar «Ahora no» y cancelación del diálogo Play sin pérdida de acceso ni repetición inmediata del aviso. Aceptar descarga, usar la app mientras descarga y volver tras enviar la app al fondo; debe aparecer «Instalar» cuando esté descargada. Completar y comparar los mismos identificadores y cookies/preferencias. Repetir sin red/sin nueva versión: no debe bloquear el turno. La vigencia natural del turno no se extiende por actualizar.

Verificación 1.0.3: compilación release firmada (AAB y APK) con R8 y lint vital correctos; regresión JVM de enlaces y referrer, 5 pruebas sin fallos. AAB de 3.038.578 bytes, SHA-256 `F1CCD0CF8E7C7D78207EBEDAC7A12D55173C6C51A434B598B208B99518AABEA7`. No se realizó la prueba física de actualización Play en este equipo; las pruebas JVM no ejercitan el diálogo ni la instalación de Play.

Publicación 1.0.3, 2026-10-29: código `c4748cb` en main. Play aceptó el AAB 4 (1.0.3) con mapa ReTrace, sin pérdida de dispositivos compatibles. Estimación de instalación 1,28 MB y actualización 415 KB. La recomendación preexistente de símbolos nativos sigue sin bloquear el envío. Estado confirmado «Cambios en la etapa de revisión», lanzamiento completo a los países existentes, verificaciones rápidas pendientes. No equivale a aprobación/disponibilidad; seguimiento de aprobación habilitado para avisar al usuario. Sin nuevo despliegue AWS/local porque sólo cambió el binario Android.

Play Console confirmó 1.0.1 (2) activa. Se habilitó `MECAN_INSTALL_PROMPT_ENABLED=1` en producción AWS, turnero AWS y turnero local Mecan, release acotada `v5.00.315-mecan-app-opening-20261028`. Los tres servicios y sus healthz fueron verificados. El backend principal recibió también la integración original de instalación que faltaba en su runtime.

El aviso se ofrece al recuperar un turno activo guardado, además de reclamar uno nuevo. Se prepara un único vínculo compartido por turno y se conserva el botón «Abrir mi turno en Mecan» aunque se cierre el modal. El botón abre un intent explícito del paquete desde el clic del usuario, con alternativa Play y referrer al mismo turno. No se intenta abrir la app automáticamente mediante JavaScript: la apertura directa del QR depende de Android App Links y de las preferencias del teléfono.

Android 1.0.2 (3) acepta ambos dominios con y sin www y los convierte al origen interno existente, preservando query y fragmento. Rechaza otros tenants, hosts, protocolos y rutas ambiguas. La compilación activa R8 y reducción de recursos, conservando los métodos del puente JavascriptInterface. Resultado: 44/44 pruebas Node focalizadas, 5/5 JVM y AAB/APK release firmado. No hubo teléfono conectado para acreditar la prueba física de instalación/QR. Las asociaciones públicas de los cuatro hosts respondieron HTTP 200 con el paquete Mecan.

AAB 1.0.2: SHA-256 `E433BC94C2EF705677F1E0EE80A89B077B39F1D436C625DA8D57118F8058E1EE`, 2.997.423 bytes. Play aceptó el paquete con mapa ReTrace; tamaño estimado de instalación 1,26 MB, 3,45 MB menos que la versión anterior. La advertencia restante del formulario corresponde a símbolos de depuración nativos de dependencias, distinta de la optimización DEX.

Estado confirmado en Console: «Cambios en la etapa de revisión», versión «1.0.2 - Enlaces QR y optimización», lanzamiento completo a los países existentes. Verificaciones rápidas en curso; no se acredita aprobación ni disponibilidad de 1.0.2 hasta que Play lo confirme. La advertencia del panel de la versión activa puede persistir hasta esa actualización. Captura operativa guardada fuera del repositorio.

Retención AWS: se eliminaron únicamente los respaldos más antiguos `c6a07705dc5f-auto-bXBKhfQ3` y `v5.00.270-catalog-sql-bdd698409e90` tras validar current 315 y siete releases por servicio. Quedan seis por servicio (activa + cinco respaldos), sin tocar respaldos Mongo. El temporizador de auto-deploy sigue deshabilitado por el fallo previo de su suite; esta publicación acotada no lo reactivó.
