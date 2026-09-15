# Turnero de Mecan en AWS

Actualizado el 14/09/2026 a las 22:11 de Argentina. Servicio publicado en AWS; la app principal sigue en 5.00.139 y no se reinició. Turnero: `/opt/asisto/turnero/releases/20260914-2`. Android: **Asisto 1.1.6**.

## Accesos reales

- Emisión: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA/kiosk
- Atención: https://asistobot.com.ar/ui/turnero/DEMO_FERRETERIA
- Pantallas: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA/display?sector=ferreteria
- Celular: https://asistobot.com.ar/customer-app/DEMO_FERRETERIA?view=turns
- APK: https://asistobot.com.ar/customer-app/download/android

El equipo emisor y los empleados inician sesión con un usuario del comercio. El celular no necesita esa sesión ni conectarse al Wi-Fi: los QR publicados usan el origen **https://asistobot.com.ar**, comprobado en la configuración productiva. `scripts/preview_queue.cjs` sirve exclusivamente una maqueta local; sus QR ficticios de localhost no sirven para teléfonos con datos móviles.

## Selección → QR o impresión

1. El visitante elige la sección. El servidor asigna un número y crea una reserva de tres minutos, sin mostrarlo en el turnero.
2. La pantalla destaca el QR exclusivo de esa reserva, con animación suave. Solo el primer celular puede asociarlo. El QR no emite otro turno.
3. Al vincularlo, el turno entra en espera y el número aparece en el celular. El emisor detecta la vinculación y vuelve al inicio.
4. Como alternativa secundaria, «Prefiero imprimir mi ticket» confirma la misma reserva y abre la impresión del navegador. El número aparece en el comprobante, no en la pantalla normal del turnero.
5. Una reserva no tomada vence y no ocupa la cola de atención. Su número no se reutiliza. La posición conserva el instante de la reserva.

La comandera prevista se conecta **por USB al equipo del turnero**. Debe instalarse su controlador y seleccionar su formato de papel en el navegador. El diseño se adapta al ancho de impresión, hasta 68 mm útiles. El navegador no confirma la salida física: si se cancela o falta papel, el usuario puede volver a imprimir **el mismo turno**. No hay impresión silenciosa ni integración ESC/POS directa en esta entrega. La prueba física queda pendiente de disponer de la impresora.

## Celular y avisos

Al escanear el QR se guarda el turno en el navegador. Para avisos en segundo plano, el cliente puede abrir ese mismo turno en **Asisto 1.1.6**, mediante un enlace temporal de un solo uso; la app conserva el número y recibe las notificaciones Firebase del dispositivo registrado. La firma del APK coincide con la versión 1.1.5, por lo que puede actualizarla conservando sus datos.

La app abre el enlace `asisto://turno` validando que el destino pertenezca a Asisto. Referencia: [enlaces profundos de Android](https://developer.android.com/training/app-links/create-deeplinks). El traspaso navegador-app conserva consulta desde ambos, y dirige los avisos a la instalación de Android. El permiso de notificaciones debe estar habilitado. El navegador por sí solo muestra el llamado mientras la página está abierta; no registra push web en segundo plano.

Los códigos de vinculación viajan en el fragmento del enlace, se validan en servidor y vencen. Un segundo celular no puede reclamar un QR tomado. Los reintentos recuperan el mismo turno. Firebase se intenta al llamar o repetir, nunca al reservar.

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

- 13 pruebas con Mongo temporal separado: concurrencia, recuperación, permisos, traslados, orden, consulta privada, firma y vencimiento de QR, reserva no atendible, primer reclamante, traspaso a Android, impresión idempotente y vencimiento de abandonados.
- Scripts incrustados del kiosco, atención, pantallas y app de clientes validan sintaxis.
- Android compiló con éxito y se verificaron la firma y su coincidencia con 1.1.5. SHA-256 APK: `c51fc17a19b5d3b41b51a1b8b444085ff980c4a632cbc30232e4646031962ca4`.
- Revisión visual del QR sin número, opción secundaria de impresión y logos. Endpoints públicos de app, pantalla, logos y APK responden 200. Escáner confirma logo, color y pie de Asisto.
- No se enviaron notificaciones reales ni se imprimió en hardware durante las pruebas. Falta comprobar esos dos recorridos con un teléfono y comandera reales.

## Migración local futura

Trasladar el servicio y Mongo, ajustar origen público/proxy y mantener un único escritor. Esta versión funciona completa en AWS y necesita internet. La instalación local sin internet sigue siendo una etapa posterior.
