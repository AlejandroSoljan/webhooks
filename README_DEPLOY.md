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


## Límites de conexiones MongoDB

Para evitar agotar el límite de conexiones de Atlas M0, el proyecto usa un único cliente/pool por proceso y valores acotados.

### Render
Variables opcionales recomendadas:

```text
MONGODB_MAX_POOL_SIZE=5
MONGODB_MAX_CONNECTING=2
MONGODB_MAX_IDLE_TIME_MS=60000
MONGO_FULL_IDLE_DISCONNECT_MS=300000
```

### PC con WhatsApp Web
Variables opcionales recomendadas:

```text
MONGO_MAX_POOL_SIZE=1
MONGO_MAX_CONNECTING=1
MONGO_MAX_IDLE_TIME_MS=60000
MONGODB_FULL_IDLE_DISCONNECT_MS=300000
```

Los valores anteriores ya son los predeterminados del código corregido.

`MAX_IDLE_TIME_MS` cierra sockets ociosos dentro del pool. `FULL_IDLE_DISCONNECT_MS` cierra el cliente Mongo completo cuando el proceso no solicita la base durante ese período. Usá `0` para desactivar el cierre completo. Los bots activos mantienen heartbeats y consultas periódicas, por lo que no se consideran inactivos y conservan su conexión.

 
Además:

- `app_asisto_ws.js` y `app_chatbot_super.js` crean un archivo PID dentro de `logs/` para impedir dos procesos simultáneos en la misma instalación.
- Ambos scripts cierran Mongoose antes de reiniciar o finalizar.
- `telegram_runtime.js` reintenta cargar las sesiones cuando MongoDB vuelve a estar disponible.

Estas correcciones reducen el consumo, pero las instalaciones de WhatsApp Web continúan conectándose directamente a MongoDB. Si existen muchas decenas de instalaciones, la solución definitiva es usar un clúster con mayor capacidad o hacer que las PC accedan a los datos mediante una API central.


