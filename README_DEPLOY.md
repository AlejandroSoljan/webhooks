# Proyecto listo (endpoint.js / Render)

Este zip incluye DOS ubicaciones de los archivos:
- En la raíz: endpoint.js, logic.js, db.js, tenant_runtime.js, auth_ui.js, etc.
- También dentro de /src con los mismos archivos.

Esto es a propósito para evitar el error de Render "Cannot find module './tenant_runtime'" si tu Start Command apunta a `src/endpoint.js`.

## Qué hacer en tu repo
Elegí UNA de estas opciones (no hace falta mantener duplicado):

### Opción A (recomendada si tu Render ejecuta src/endpoint.js)
1) Copiá el contenido de la carpeta `src/` de este zip a tu carpeta `src/` del repo.
2) Asegurate que en Render el Start Command sea:
   node src/endpoint.js

### Opción B (si tu Render ejecuta endpoint.js desde raíz)
1) Copiá los archivos de la raíz de este zip a la raíz del repo.
2) Start Command:
   node endpoint.js

## Multi-tenant/multi-teléfono
La colección `tenant_channels` permite configurar por tenant+phone_number_id:
- whatsappToken, verifyToken, openaiApiKey, etc.
El webhook resuelve automáticamente por `value.metadata.phone_number_id`.

