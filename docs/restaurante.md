<!-- Asisto | Version: 5.00.162 | Fecha: 2026-09-19 -->
# Restaurante RES

## Pedido y marca (5.00.162)

El acceso superior **Mi pedido** abre los artículos agregados todavía sin enviar;
permite sumar/quitar unidades y muestra su total. Desde allí se accede a pedidos
enviados y cuenta, que también avisa si quedan artículos pendientes de confirmar.
El borrador se conserva al recargar en la misma pestaña durante dos horas, separado
por dominio y mesa. Si el navegador bloquea almacenamiento, se puede pedir igual,
pero no se garantiza conservar el borrador al recargar. El envío exitoso limpia
el borrador y muestra el seguimiento cuando está habilitado.
La carta usa azul/blanco/celeste. Carta, paneles de cliente y operaciones incluyen
el icono y enlace **Powered by Asisto · asistobot.com.ar**.

## Carta simplificada (5.00.161)

La pantalla inicial muestra categorías desplegables. Los platos tienen fotos
pequeñas con lupa: al tocarlas se abre la foto ampliada y la composición.
El nombre del plato también abre los ingredientes. Al agregar artículos aparece
un botón fijo con cantidad y total para revisar y confirmar el pedido.
**Necesito algo** reúne llamados al mozo, solicitud de cuenta, IA y avisos.
**Mi cuenta** reúne seguimiento, saldo, división y Mercado Pago informativo.
Los paneles pueden cerrarse para seguir explorando la categoría sin perder el carrito.

## Control de sala (5.00.160)

En **Restaurante → Control de mesas**, seleccioná una mesa para abrir una cuenta,
asignar comensales/mozo, reservar, cargar o editar pedidos y avanzar sus estados:
recibido, en preparación, listo y entregado. Los llamados y pedidos de cuenta se
atienden desde el detalle. La vista de cocina reúne comandas pendientes.

Los pagos son registros manuales de dinero recibido: efectivo, tarjeta,
transferencia o Mercado Pago confirmado por el operario. Admiten pagos parciales;
anular exige motivo. No se editan ni cancelan pedidos mientras haya pagos vigentes.
Para cerrar la mesa, el saldo debe ser cero y los pedidos entregados/cancelados.
La siguiente apertura archiva la visita anterior en `restaurant_service_history`.
Cada actualización compara `opsRevision` para evitar sobrescribir cambios de otro
operario. Ante un conflicto, usar **Actualizar detalle** y revisar antes de guardar.
Los pedidos QR usan una clave de reintento para evitar duplicados en la misma visita.

Las comandas anteriores a esta versión se ofrecen para **Incorporar a esta cuenta**;
conservan su precio original y no se agregan automáticamente a una visita nueva.

En **Funciones habilitadas para esta empresa**, el dominio seleccionado configura
fotos, pedidos por celular, IA de cliente/operario, llamar al mozo, pedir cuenta,
Mercado Pago, avisos, seguimiento, cocina, pagos manuales y división de cuenta.
Se guardan en `tenant_config.restaurant_features`; pedidos conserva compatibilidad
con `restaurant_orders_enabled`. Por defecto están habilitadas. Desactivar fotos
conserva los archivos cargados. Desactivar pedidos no impide cargarlos en el panel.

Mercado Pago es un botón informativo: no abre checkout, no cobra y no cambia el
estado de pago. La integración de cobro y validación automática queda pendiente.
El cliente puede seguir sus pedidos y ver el saldo total de su mesa cuando tiene
un pedido asociado a su sesión. Dividir cuenta solo calcula un importe estimado.
El asistente del operario usa carta y estado de sala; no modifica pedidos ni pagos.
Los avisos y el seguimiento se actualizan cada 10 segundos con la carta abierta;
no se implementó entrega push al cliente con la página cerrada.

El dominio `RES` usa los artículos de `products` como carta. `descripcion` es el nombre, `tag` la categoría, `importe` el precio y `observacion` contiene ingredientes, alérgenos y variantes conocidas. Los artículos inactivos no se muestran. `cantidad: 0` los muestra como no disponibles. Los precios y recetas iniciales son ejemplos y deben revisarse antes de publicar los QR.

`imagen` es una URL HTTPS o una imagen cargada desde el alta de artículos (JPG, PNG o WebP, hasta 2 MB). Los archivos cargados se guardan en `product_images` y se sirven por `/resto/image/<id>`. La carta muestra la imagen por artículo. RES incluye fotos de muestra generadas para el menú inicial; `node scripts/seed_res_images.js --apply` las asigna solo a artículos que todavía no tienen imagen. El script exige el host AWS y la base productiva `Cluster0`.

`node scripts/seed_restaurant_res.js --apply-production`, ejecutado en AWS con el entorno productivo verificado, crea o actualiza de forma repetible la configuración de RES, 19 artículos y 10 mesas. Conserva los tokens QR existentes. Las mesas se guardan en `restaurant_tables`; cada una tiene un token aleatorio de 128 bits. La carta pública está en `/resto/RES/<token>`.

El panel está en `/ui/resto?tenant=RES` para superadministradores y en `/ui/resto` para usuarios del dominio RES. Muestra eventos pendientes de `restaurant_events`, pedidos con precios calculados desde Mongo, llamados y pedidos de cuenta. Permite marcarlos como atendidos y muestra los QR de las mesas. Los usuarios restringidos necesitan el permiso `resto`; para editar la carta también necesitan `productos`.

En el panel, cada empresa puede desactivar la toma de pedidos desde el celular (`restaurant_orders_enabled=false`). La carta oculta la cesta y los botones de agregar; el servidor rechaza eventos `order`. Llamar al mozo, pedir la cuenta y consultar la carta siguen disponibles. El valor ausente conserva los pedidos habilitados.

Cada carta abierta registra una sesión anónima aleatoria en `restaurant_visitors`. El panel muestra cuántas sesiones están activas por mesa y permite enviarles un mensaje. La carta consulta `restaurant_guest_notifications` cada 10 segundos, muestra los mensajes en pantalla y, si el cliente acepta el permiso, usa notificaciones del navegador mientras la página está abierta. Al marcar una solicitud como atendida, la sesión que la creó recibe también un aviso. Estas sesiones no son la app de turnos ni requieren identificar al cliente. El envío en segundo plano con la página cerrada requiere una integración web push o app móvil adicional.

La descarga imprimible de todos los QR activos está en `/api/resto/qr-pdf?tenant=RES`. Requiere iniciar sesión con permiso `resto`. El PDF se genera con los tokens de mesas de la base que usa la aplicación publicada.

El panel del restaurante y el alta de artículos permiten al superadmin elegir dominio. El panel propone un dominio que tenga restaurante habilitado y muestra las mesas, artículos y pendientes del dominio seleccionado. Los operadores comunes quedan limitados a su propio dominio. Desde el panel se pueden habilitar nuevos dominios existentes y agregar mesas.

El botón de avisos del panel solicita permiso de notificaciones del navegador. Avisa sobre eventos nuevos mientras la página está abierta. Para apps Android/iPhone se reserva `restaurant_operator_devices`: la app autenticada registra su token FCM mediante `POST /api/resto/devices?tenant=...`, con `deviceId`, `pushToken` y `platform` (`android` o `ios`). Los eventos guardados intentan entregar push a los dispositivos registrados del mismo dominio; el evento y el panel siguen funcionando si Firebase no responde. La autenticación propia de las apps nativas y el registro automático del token en ellas quedan para esa integración futura.

Las consultas de IA usan `OPENAI_API_KEY_CONVERSACIONAL` y el modelo `restaurant_ai_model` de `tenant_config`. La carta se vuelve a leer para cada consulta. La respuesta tiene la instrucción de usar solo los datos cargados y remitir al personal cuando falte información de alergias. Hay límites básicos de solicitudes por mesa. La toma de pedidos guarda comandas para el operario; no procesa pagos ni confirma preparación automáticamente.

Antes de entregar los QR: revisar precios, composición y contaminación cruzada; configurar la clave de IA; desplegar la versión del servidor que incluye `restaurant.js`; crear un usuario RES con acceso `resto` (y `productos` si edita el menú); comprobar un pedido completo desde una mesa de prueba.
