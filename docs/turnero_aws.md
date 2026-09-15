# Turnero de Mecan en AWS

Actualizado el 14/09/2026 a las 22:46 de Argentina. Servicio publicado en AWS; la app principal sigue en 5.00.139 con la actualización corregida del menú y notificaciones. Turnero: `/opt/asisto/turnero/releases/20260914-5`. Android: **Asisto 1.1.7**.

## Accesos reales

- Emisión: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA/kiosk
- Atención: https://asistobot.com.ar/ui/turnero/DEMO_FERRETERIA
- Pantallas: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA/display?sector=ferreteria
- Celular: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA?view=turns
- APK: https://asistobot.com.ar/customer-app/download/android

El equipo emisor y los empleados ingresan temporalmente sin login en Mecan; el panel de estadísticas usa la sesión Asisto del comercio. El celular no necesita esa sesión ni conectarse al Wi-Fi: los QR publicados usan el origen **https://asistobot.com.ar**, comprobado en la configuración productiva. `scripts/preview_queue.cjs` sirve exclusivamente una maqueta local; sus QR ficticios de localhost no sirven para teléfonos con datos móviles.

## Selección → QR o impresión

1. El visitante elige la sección. El servidor asigna un número y crea una reserva de tres minutos, sin mostrarlo en el turnero.
2. La pantalla destaca el QR exclusivo de esa reserva, con animación suave. Solo el primer celular puede asociarlo. El QR no emite otro turno.
3. Al vincularlo, el turno entra en espera y el número aparece en el celular. El emisor detecta la vinculación y vuelve al inicio.
4. Como alternativa secundaria, «Prefiero imprimir mi ticket» confirma la misma reserva y abre la impresión del navegador. El número aparece en el comprobante, no en la pantalla normal del turnero.
5. Una reserva no tomada vence y no ocupa la cola de atención. Su número no se reutiliza. La posición empieza al activar el turno (escanear o solicitar impresión).

La comandera prevista se conecta **por USB al equipo del turnero**. Debe instalarse su controlador y seleccionar su formato de papel en el navegador. El diseño se adapta al ancho de impresión, hasta 68 mm útiles. El navegador no confirma la salida física: si se cancela o falta papel, el usuario puede volver a imprimir **el mismo turno**. No hay impresión silenciosa ni integración ESC/POS directa en esta entrega. La prueba física queda pendiente de disponer de la impresora.

## Celular y avisos

Con **Asisto 1.1.7** instalado, el QR HTTPS puede abrir directamente la app mediante Android App Links. Si la app no está instalada o Android no permite abrir enlaces compatibles, abre el navegador y ofrece pasar el turno a Asisto mediante un enlace temporal de un solo uso; la app conserva el número y recibe las notificaciones Firebase del dispositivo registrado. La firma del APK coincide con la versión 1.1.5, por lo que puede actualizarla conservando sus datos.

La app abre el enlace `asisto://turno` validando que el destino pertenezca a Asisto. Referencia: [enlaces profundos de Android](https://developer.android.com/training/app-links/create-deeplinks). El traspaso navegador-app conserva consulta desde ambos, y dirige los avisos a la instalación de Android. El permiso de notificaciones debe estar habilitado. El navegador por sí solo muestra el llamado mientras la página está abierta; no registra push web en segundo plano.

Los códigos de vinculación viajan en el fragmento del enlace, se validan en servidor y vencen. Un segundo celular no puede reclamar un QR tomado. Los reintentos recuperan el mismo turno. Firebase avisa al quedar 2 turnos por delante, 1 y al llamar. La posición incluye el turno en atención. No envía a reservas sin activar. Los hitos exitosos quedan guardados en queue_tickets.queueNotifications, por visita a sección; los traslados reinician esa secuencia. Repetir llamado es una acción explícita y genera otro aviso. Reintentos de operaciones y barridos no repiten hitos exitosos. Si el cliente vincula tarde la app se envía solo el aviso de su posición actual, no los anteriores.

## Atención

Se seleccionan sección y puesto. Acciones: llamar siguiente, repetir, finalizar, ausente y trasladar. El traslado mantiene identificador y número, registra historial y coloca el turno al final de la sección de destino. Esta versión permite **un turno en atención por sección**; diferentes empleados pueden operar secciones distintas y los conflictos entre pantallas se rechazan.

Un administrador puede elegir emisión móvil directa libre o con QR presencial, y definir una promoción de texto opcional. El QR de vinculación de una reserva ya creada en el kiosco funciona independientemente de ese ajuste. No hay GPS, canje de cupones ni descuentos inventados.

## Marca

Logo oficial tomado de [Mecan](https://www.mecan-sa.com.ar/), con rojo, negro, blanco y grises. Activo original: https://acdn-us.mitiendanube.com/stores/006/162/992/themes/common/logo-1698153320-1745951504-1c991c8de62e18e97e365103230802a81745951504-480-0.webp

Los activos se sirven desde AWS en `/customer-app/assets/`; no dependen del sitio externo para renderizar. Emisión, QR, atención, pantalla de llamados, vistas móviles y comprobante incluyen «Powered by Asisto» con su icono. El escáner de productos ya tenía ese pie; sus campos `qr_company_logo_url`, `qr_button_color` y `qr_button_text_color` se ajustaron para Mecan sin cambiar su catálogo. Se respaldaron los valores anteriores en `/var/lib/asisto/turnero-brand-before-20260914.json`.

## Operación

`asisto-turnero` escucha solo en `127.0.0.1:3102`. Nginx publica las rutas de clientes y turnero por HTTPS. El loopback del servicio no aparece en los QR. Se comparten la base y las cookies existentes, mediante `/etc/asisto/production.env`; el secreto propio se guarda en `/etc/asisto/turnero.env`.

Un solo proceso escribe las colas. No levantar réplicas ni volver a enrutar las API al motor anterior. Las operaciones se serializan por comercio; cada transición se guarda en un documento Mongo. Las colas se separan por día de Buenos Aires. Se mantienen los contadores anteriores y se agregan índices. Los estados son RESERVED, WAITING, CALLED, DONE, SKIPPED y CANCELLED.

Los archivos auxiliares de autenticación y Firebase se copiaron de la release vigente. `node_modules` apunta a esa release: conservarla y sincronizar futuras actualizaciones de dependencias/autenticación. Los scripts de `deploy/turnero` registran instalación inicial, actualización y ajuste visual. No se debe volver al motor viejo después de usar reservas/traslados: no comprende esos estados ni su orden.

## Verificación

- 17 pruebas con Mongo temporal separado: concurrencia, recuperación, permisos, traslados, orden, consulta privada, firma y vencimiento de QR, reserva no atendible, primer reclamante, traspaso a Android, impresión idempotente y vencimiento de abandonados.
- Scripts incrustados del kiosco, atención, pantallas y app de clientes validan sintaxis.
- Android compiló con éxito y se verificaron la firma y su coincidencia con 1.1.5. SHA-256 APK: `f3155cb64aa7bdd8f434217bc49cda95bc6bebedf6a9d0119932dcb277c63df4`.
- Revisión visual del QR sin número, opción secundaria de impresión y logos. Endpoints públicos de app, pantalla, logos y APK responden 200. Escáner confirma logo, color y pie de Asisto.
- No se enviaron notificaciones reales ni se imprimió en hardware durante las pruebas. Falta comprobar esos dos recorridos con un teléfono y comandera reales.

## Migración local futura

Trasladar el servicio y Mongo, ajustar origen público/proxy y mantener un único escritor. Esta versión funciona completa en AWS y necesita internet. La instalación local sin internet sigue siendo una etapa posterior.

## Avisos, acceso temporal y estadísticas (1.1.7)

- Release AWS actual: `/opt/asisto/turnero/releases/20260914-5`, puerto 3102. App principal: `/opt/asisto/releases/5cf94e5354a5-turnero-notifications-fixed`. La release 4 corrigió el barrido para Mongo API estricta con aggregate + group; la 5 incorporó el historial automático y el filtro. Ambos servicios mantienen sus releases anteriores para rollback.
- QUEUE_OPEN_TENANTS=DEMO_FERRETERIA en /etc/asisto/turnero.env habilita emisión y operación sin login solo en ese comercio, a pedido del usuario. Retirar ese valor y reiniciar el servicio restablece el login. Los eventos anónimos guardan operador-sin-login y puesto; no identifican una persona.
- Panel: https://asistobot.com.ar/ui/turnero/DEMO_FERRETERIA/estadisticas. Enlace desde atención. Requiere sesión Asisto del mismo comercio o superadmin. API /api/customer-app-admin/:tenant/stats?from=AAAA-MM-DD&to=AAAA-MM-DD.
- Mongo queue_tickets conserva fechas, estado, entrega e historial (creación, activación, primer llamado, repeticiones, cierre, ausencia, traslado y puesto). El panel reconstruye todas las visitas a secciones, incluidas las anteriores a esta actualización. Promedios excluyen etapas incompletas, P90 espera, conteos por día/sección/hora, datos de móvil/impresión y CSV de recorridos sin identificadores de dispositivos ni códigos QR. No hay borrado automático de históricos.
- Filtros por día de emisión, zona America/Argentina/Buenos_Aires, hasta 93 días y 50.000 turnos por consulta. Si se supera el límite pide acortar el rango y nunca entrega totales truncados.
- La espera empieza en activación o traslado y termina en el primer llamado. Atención significa tiempo desde ese llamado hasta finalizar, ausente o trasladar. Repetir llamado no reinicia la medición. El CSV expresa instantes ISO UTC y duraciones en segundos.
- Barrido de notificaciones cada 15 segundos; también después de mutaciones y registro del celular. Reintenta fallos después de 30 segundos mientras el hito siga vigente. El envío es aceptación por Firebase, no garantía de visualización: requiere token y permiso Android. Una caída entre aceptación FCM y registro Mongo puede repetir un envío (FCM no ofrece transacción con Mongo).
- Android App Links: host asistobot.com.ar, ruta exacta /customer-app/DEMO_FERRETERIA (incluye query/fragment). /.well-known/assetlinks.json se publica JSON por HTTPS, sin redirecciones, con la huella del APK verificada. El esquema asisto://turno continúa como alternativa desde el navegador. No se modifica la firma de la app.
- Firma 1.1.7: 45:A5:2D:AB:8C:88:F8:B9:52:A8:35:CB:C3:37:41:FB:68:C8:81:AE:B1:98:D2:7E:48:F1:7F:9F:84:09:D4:90. Paquete ar.com.asistobot.scanner.
- Todos los pies del turnero, modal, celular, estadísticas y comprobante muestran Powered by Asisto + www.asistobot.com.ar. El escáner de productos ya incluía esa web.
- El Centro de notificaciones registra `notificationType=manual` para envíos humanos y `notificationType=automatic_queue` para los hitos del turnero. Los registros manuales anteriores, que no tienen este campo, se consideran manuales. El panel permite filtrar Todas, Manuales y Automáticas por turnos; muestra número y sección en estas últimas. El total de envíos correctos responde al filtro visible.
- El menú principal de Asisto muestra “Estadísticas Turnero” a usuarios del comercio con acceso a Notificaciones App. El destino se arma con el tenant de la sesión y mantiene la autorización del panel estadístico.
- Se importaron de forma idempotente los avisos automáticos anteriores que todavía estaban registrados dentro de los tickets. Resultado inicial: 2 avisos automáticos de 1 ticket; el historial manual existente quedó intacto.
- Incidente 14/09 22:41 Argentina: el primer enlace de menú llamó a un helper inexistente (`tenant`) durante la construcción del shell y provocó “Error interno de login”. Se revirtió de inmediato la app principal a `5cf94e5354a5`; el turnero siguió activo. La corrección usa normalización local y agrega una prueba de ejecución real de `getNavItemsForUser` para usuarios con tenant, sin tenant y sin permiso.
- Verificación: 17 pruebas pasaron, build Android y firma OK; endpoints públicos 200, ingreso kiosco/atención sin redirección, APK 1.1.7 y assetlinks JSON correctos. Panel revisado visualmente con datos ficticios aislados. Pendiente verificar apertura automática y recepción real con un teléfono instalado y permiso concedido, y comandera USB física.
