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




## Migración de agentes WhatsApp Web a API HTTPS (v4.01.18)

Esta versión elimina la conexión MongoDB directa de las PC cuando el agente tiene configurada la API de control.
Las sesiones WhatsApp continúan en `LocalAuth`; no se mueve ni borra la carpeta local.

### Flujo de transición automático

1. La PC inicia con su `mongo_uri` actual.
2. Lee una última vez `tenant_config`.
3. Obtiene la URL y el token de control.
4. Los guarda en `configuracion.json`.
5. Ejecuta `mongoose.disconnect()`.
6. A partir de ese momento usa solamente HTTPS contra Render.

En el log debe aparecer:

```text
[CONTROL_API] migración completada; MongoDB directo deshabilitado
[CONTROL_API] conectado mode=https
```

El endpoint predeterminado es:

```text
https://www.asistobot.com.ar/api/ext/wweb/agent
```

Puede sobrescribirse con `control_api_url` en `tenant_config` o con
`WWEB_CONTROL_API_URL` en la PC.


El agente usa, en este orden:

1. `control_api_token` de `tenant_config`.
2. `status_token` del tenant.
3. `WWEB_CONTROL_API_TOKEN` de la PC.

Render acepta el `WWEB_API_KEY` global o el `control_api_token/status_token`
del tenant. No se debe registrar el token en los logs.

Ejemplo de campos opcionales en `tenant_config`:

```json
{
  "control_api_enabled": true,
  "control_api_url": "https://www.asistobot.com.ar/api/ext/wweb/agent",
  "control_api_token": "1234"
}
```

Si el tenant ya tiene `status_token`, no es obligatorio crear
`control_api_token`: la migración lo utiliza automáticamente.

### Verificación

En la PC:

```text
http://localhost:PUERTO/status
```

Debe mostrar:

```json
{
  "dataBackend": "https_control_api"
}
```

Cuando todas las PC informen `https_control_api`, se puede cambiar la clave del
usuario MongoDB antiguo y quitar las IP de las PC de Atlas. Render, Telegram y
la web seguirán compartiendo el único pool definido en `db.js`.

### Archivos agregados/modificados

- `wweb_control_client.js`: cliente HTTPS y fachada compatible con las operaciones usadas por el agente.
- `app_asisto_ws.js`: transición automática, persistencia local y reemplazo del acceso directo a MongoDB.
- `endpoint.js`: API autenticada y limitada a las colecciones necesarias del agente.