# Arquitectura: mapa para colaboradores

Referencia inicial del 2026-11-02. Consultar el manual funcional y el código para contratos detallados.

| Área | Referencias | Función |
|---|---|---|
| Backend | endpoint.js, package.json | Node 24, CommonJS, Express y montaje de servicios |
| Persistencia | db.js | MongoDB; MONGODB_URI y MONGODB_DBNAME |
| Productos | qr_product_web.js, product_insights.js, product_insights_routes.js, product_insights_panel.js | Catálogo y estadísticas de consultas |
| Turnero | customer_queue.js, queue_cloud_sync.js, queue_stats_page.js | Turnos, estadísticas y sincronización híbrida |
| App y notificaciones | customer_app_web.js, customer_notifications.js, app_center.js | Web del comercio, dispositivos y actividad |
| Consumos | monetization_engine.js, monetization_config.js | Eventos monetizables y conceptos |
| WhatsApp | docs/whatsapp_support.md | Backend y agentes con despliegue propio |

## Entornos

La fuente autoritativa publicada es Cluster0 en AWS Lightsail, accesible administrativamente por SSH al alias asisto-aws. MongoDB permanece en loopback. Mecan tiene otro nodo y funciones específicas; no intercambiar configuraciones ni sustituir la base central por una copia local.

Rutas operativas observadas: /opt/asisto/current (producción), /opt/asisto/turnero/current (turnero AWS), /opt/asisto/turnero-local/current (Mecan). Son enlaces a releases; comprobar su destino antes de operar. Documentar estas rutas no autoriza acceso.

El informe de productos local consulta el resumen central mediante queue-sync. Las consultas de productos no equivalen a lecturas del QR del turnero, ventas ni clientes únicos.

## Identidad

Distinguir usuario, rol, permisos de pantalla, dominio de origen y agrupación de facturación. Un dominio secundario puede facturarse a otro sin perder atribución de actividad. Validar autorización en servidor; ocultar controles no reemplaza permisos. No fusionar celulares por marca/modelo o IP.

## Contratos

Consultar [manual técnico](MANUAL_TECNICO_ASISTO.md), [rutas](manual-tecnico/rutas.md), [variables](manual-tecnico/entorno.md), [colecciones](manual-tecnico/colecciones.md) y [variables por dominio](manual-tecnico/variables-dominio.md). Los inventarios estáticos no prueban montaje de rutas ni configuración activa de un release.
