# Turnero en AWS

Implementación del 14/09/2026 sobre la app 5.00.139. AWS ya está en producción.

## Pantallas

- `/customer-app/DEMO_FERRETERIA/kiosk`: pantalla táctil; requiere iniciar sesión con un usuario del comercio. Abrir la misma dirección en uno o dos equipos. Cada emisión tiene un identificador independiente y vuelve al inicio a los 18 segundos.
- `/customer-app/DEMO_FERRETERIA/display?sector=ferreteria`: pantalla pública de llamados. Se puede seleccionar otra sección o mostrar todas. Activar sonido una vez en cada pantalla.
- `/ui/turnero/DEMO_FERRETERIA`: atención con usuario del comercio; puesto, sección, llamado, repetición, finalización, ausente y traslado.
- `/customer-app/DEMO_FERRETERIA?view=turns`: celular con Wi-Fi o datos móviles. La app Android existente carga la misma web.

El traslado conserva identificador y número, deja historial y coloca el turno al final de la sección de destino. Esta primera versión permite **un turno en atención por sección**; distintos empleados pueden operar las secciones con control de conflictos.

## Presencia y promoción

En «Opciones del turnero» un administrador elige acceso libre o QR presencial. El QR firmado vence a los 90 segundos y se renueva cada 45 segundos. La validación aplica a nuevas emisiones; consultar un turno existente no requiere seguir dentro del local. La pantalla de emisión exige sesión para evitar que un visitante remoto obtenga QR válidos. No hay GPS ni detección de Wi-Fi en esta versión.

La promoción es texto opcional (hasta 240 caracteres), inicialmente vacío. Es un mensaje comercial; no genera ni canjea cupones. El comercio debe indicar una oferta vigente y sus condiciones. Se actualiza en el turnero al renovar el QR.

Al llamar o repetir el llamado se intenta enviar Firebase al dispositivo registrado. Crear un turno no manda un aviso de llamado. El estado de entrega se informa por API; la pantalla de llamados funciona aunque Firebase falle. Abrir el QR en un navegador no registra por sí solo notificaciones push de Android.

## Instalación y operación

Servicio independiente `asisto-turnero`, puerto `127.0.0.1:3102`, base y cookies de sesión existentes. Nginx dirige exclusivamente las rutas de la app de clientes y turnero a ese servicio. WhatsApp, escaneo `/qr`, bots y el proceso principal no se reinician para esta instalación.

`deploy/turnero/install.sh` instala un paquete revisado en `/opt/asisto/turnero/releases/20260914-1`, genera un secreto propio en `/etc/asisto/turnero.env`, verifica salud y autenticación antes de recargar Nginx. El secreto nunca se publica en el repositorio. Usa las credenciales existentes mediante `DOTENV_CONFIG_PATH=/etc/asisto/production.env`.

**Un solo proceso debe escribir los turnos.** No arrancar réplicas ni volver a enrutar las API viejas mientras este servicio atiende. La serialización entre emisiones y movimientos es por comercio en el proceso. Mongo guarda cada transición de un turno en una única actualización. Se reutilizan los contadores anteriores y se agregan índices; números de turnos existentes no cambian. Las colas se separan por día de Buenos Aires.

Los archivos auxiliares de autenticación y notificaciones se copian de la release vigente; node_modules apunta a esa release. Conservar esa release mientras el servicio la utilice. Futuras actualizaciones de autenticación, base o dependencias deben actualizar también el paquete del turnero.

Para revertir una publicación defectuosa, devolver el enlace `current` del turnero a una release compatible y reiniciar solo `asisto-turnero`. **No volver al motor viejo después de trasladar turnos**: ordena por número de origen y no entiende el historial ni las posiciones de destino. La copia de Nginx anterior es solo respaldo de configuración, no un procedimiento seguro de reversión de datos.

## Pruebas

`QUEUE_TEST_MONGOD=/usr/bin/mongod node --test tests/customer_queue.test.js`. Las pruebas levantan un Mongo temporal en puerto aleatorio y con carpeta propia, sin credenciales ni conexión a la base productiva. Cubren concurrencia entre turneros, reintentos, autorización por comercio, traslados, orden de destino, consultas privadas y firmas/vencimiento de QR; Firebase se reemplaza por un simulador.

## Próxima instalación local

Se puede trasladar este servicio y su Mongo al comercio, ajustar el origen público y el proxy, y mantener un único escritor. Esta entrega depende de internet porque funciona en AWS. Impresión física, múltiples puestos simultáneos dentro de una misma sección, GPS y canje automático de promociones quedan fuera de esta primera versión.

## Publicación verificada

Publicado el 14/09 a las 21:06 de Argentina en `18.228.233.189`. Servicio habilitado al arranque, sin reinicios del proceso principal (que conserva su inicio de las 23:25:55 UTC). Salud del turnero y Mongo correctas. Verificación pública: app de clientes, pantalla y estado devuelven 200; kiosco anónimo redirige al login y API de atención anónima devuelve 401. La pantalla pública mostró las cinco secciones y el turno existente, sin emitir turnos de prueba en producción.

Ocho pruebas automatizadas aprobadas con Mongo temporal separado, más revisión visual de emisión y atención en escritorio y de la pantalla publicada. La entrega de Firebase a un teléfono físico debe comprobarse con un equipo registrado; las pruebas automáticas simulan Firebase para no enviar avisos reales.
