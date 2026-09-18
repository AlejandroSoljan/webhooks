<!-- Asisto | Version: 5.00.155 | Fecha: 2026-09-18 -->
# Restaurante RES

El dominio `RES` usa los artículos de `products` como carta. `descripcion` es el nombre, `tag` la categoría, `importe` el precio y `observacion` contiene ingredientes, alérgenos y variantes conocidas. Los artículos inactivos no se muestran. `cantidad: 0` los muestra como no disponibles. Los precios y recetas iniciales son ejemplos y deben revisarse antes de publicar los QR.

`node scripts/seed_restaurant_res.js --apply-production`, ejecutado en AWS con el entorno productivo verificado, crea o actualiza de forma repetible la configuración de RES, 19 artículos y 10 mesas. Conserva los tokens QR existentes. Las mesas se guardan en `restaurant_tables`; cada una tiene un token aleatorio de 128 bits. La carta pública está en `/resto/RES/<token>`.

El panel está en `/ui/resto?tenant=RES` para superadministradores y en `/ui/resto` para usuarios del dominio RES. Muestra eventos pendientes de `restaurant_events`, pedidos con precios calculados desde Mongo, llamados y pedidos de cuenta. Permite marcarlos como atendidos y muestra los QR de las mesas. Los usuarios restringidos necesitan el permiso `resto`; para editar la carta también necesitan `productos`.

Las consultas de IA usan `OPENAI_API_KEY_CONVERSACIONAL` y el modelo `restaurant_ai_model` de `tenant_config`. La carta se vuelve a leer para cada consulta. La respuesta tiene la instrucción de usar solo los datos cargados y remitir al personal cuando falte información de alergias. Hay límites básicos de solicitudes por mesa. La toma de pedidos guarda comandas para el operario; no procesa pagos ni confirma preparación automáticamente.

Antes de entregar los QR: revisar precios, composición y contaminación cruzada; configurar la clave de IA; desplegar la versión del servidor que incluye `restaurant.js`; crear un usuario RES con acceso `resto` (y `productos` si edita el menú); comprobar un pedido completo desde una mesa de prueba.
