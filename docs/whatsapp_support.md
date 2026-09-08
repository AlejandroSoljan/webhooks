<!-- Asisto | Version: 5.00.052 | Fecha: 2026-09-08 -->
# Tickets desde WhatsApp: diseño y primera vertical

## Estado de esta entrega

Vertical experimental, con procesamiento desactivado por defecto. Incluye sesión Baileys por usuario, QR en la web, ingestión continua y de eventos de historial, agrupación temporal, borradores editables, aprobación local, memoria manual de contactos y medición. **HubSpot queda para la última etapa:** no se pide token ni se invoca su API con la configuración predeterminada. Ninguna aprobación activa un envío remoto.

## Orden de validación acordado

1. Activar el worker reutilizando la configuración existente de Asisto; vincular un WhatsApp desde el QR y comprobar reconexión sin volver a escanear.
2. Probar un contacto habilitado y uno excluido, mensajes entrantes/salientes y un período histórico corto. Confirmar que cada ventana conserva el contexto.
3. Configurar el transcriptor local y probar un audio real. Revisar su texto, tiempo de procesamiento y resultado antes de analizar un volumen mayor.
4. Revisar un lote pequeño de borradores, recordar nombres de empresa/contacto, editar y aprobar dentro de Asisto. Corregir detección y agrupación con los casos observados.
5. Finalmente conectar HubSpot, verificar identidades y valores internos, completar conciliación de tareas abiertas y habilitar publicación con aprobación. La aprobación local previa no equivale a autorización automática de envío futuro.

Se puede recordar una empresa y un contacto y aprobar borradores sin IDs ni token de HubSpot. La memoria manual se marca `source: manual`, no como identidad verificada. Cambiarla manualmente elimina cualquier verificación e IDs remotos anteriores para evitar asociaciones incorrectas.

El menú lateral de Asisto incluye **Tickets desde WhatsApp** para usuarios con permiso `support`. Abre `/ui/support`, que conserva el menú lateral y muestra el panel `/admin/support` dentro del shell existente. Si el procesamiento todavía no está configurado, el panel muestra los pasos pendientes, sin iniciar sockets ni habilitar operaciones. También puede abrirse directamente `/admin/support`. No requiere la extensión de Chrome, automatización visual ni agentes de escritorio del proyecto MSM. Las integraciones existentes no se sustituyen.

## Arquitectura encontrada

- `package.json`: Node 24, CommonJS; `npm start` ejecuta `endpoint.js`. `server.js` es un arranque alternativo que agrega Telegram.
- `endpoint.js`: aplicación Express monolítica que monta módulos y paneles. Importarla puede activar temporizadores existentes; por eso las pruebas nuevas montan el router de soporte aislado.
- `db.js`: pool MongoDB compartido con desconexión por inactividad. Las rutas nuevas resuelven `getDb()` por solicitud; el worker mantiene actividad mientras corre.
- `auth_ui.js`: cookie de sesión firmada; `attachUser` vuelve a consultar `users` para obtener `uid`, `tenantId`, rol, permisos y bloqueo. Se agrega el permiso de pantalla `support`, configurable desde Usuarios.
- `tenant_runtime.js` / `tenant_channels`: configuración de canales existentes. Algunos secretos legacy no están cifrados; el módulo nuevo no los reutiliza ni modifica.
- `app_asisto_ws.js`, `wweb_control_client.js` y endpoints `/api/wweb`: transporte preexistente mediante agentes externos. Sigue funcionando independientemente.
- Tests anteriores: catálogo de productos, QR e importaciones mediante `node:test`.

## Componentes nuevos

| Archivo | Responsabilidad |
| --- | --- |
| `src/support/core.js` | Validación, ámbito autenticado, exclusiones, agrupación, detector local |
| `crypto.js` | AES-256-GCM con claves versionadas y datos autenticados por registro |
| `migration.js` | Migración aditiva 001 e índices |
| `service.js` | Ingestión, cola MongoDB, borradores, revisión, uso y auditoría |
| `baileys.js` | Auth cifrada en MongoDB, socket, QR, eventos y transcriptor local opcional |
| `worker.js` | Proceso separado con lease exclusivo y recuperación |
| `hubspot.js` | Consultas API, metadatos y preparación de payload sin envío |
| `routes.js`, `panel.html`, `static/support.*` | API autenticada y bandeja con actualización cada 5 segundos |
| `config.js` | Diagnóstico de preparación sin exponer valores de variables ni secretos |

## Modelo de datos

Todas las colecciones comienzan con `support_`. Los registros de usuario incluyen `tenantId` y `userId`; nunca se toman estos campos del body, query o headers. Incluso un superadmin opera su propio ámbito de soporte. El token de HubSpot pertenece al tenant y únicamente un administrador de ese tenant puede reemplazarlo.

| Colección | Clave / contenido |
| --- | --- |
| `sessions` | Única por tenant/usuario; estado deseado y observado, QR cifrado con caducidad, intentos y eventos |
| `auth` | `_id` determinista por tenant/usuario/tipo/clave Signal; credenciales y buffers cifrados |
| `settings` | Configuración por usuario; `userId: '*'` reservado para exclusiones del tenant |
| `messages` | `_id` = hash de tenant/usuario/chat/ID WhatsApp/dirección; texto y mensaje de audio original cifrados, fechas, `queued` |
| `jobs` | Trabajo por chat y rango, generación, estado, vencimiento, claim, intentos |
| `drafts` | IDs de evidencia, fingerprint, campos y fuente cifrados, revisión, estado y eventos humanos |
| `memory` | Única por tenant/usuario/JID; nombres manuales, procedencia y eventos; IDs/verificación opcionales para la etapa final |
| `integrations` | Única por tenant; token cifrado y eventos de reemplazo |
| `usage` | Modelo, tarea/conversación, tokens, segundos de audio, unidades, costo, duración y resultado |
| `audit` | Operaciones de procesamiento, solicitudes históricas y fallos sin secretos |
| `leases` | Exclusión global del worker de esta vertical |
| `migrations` | Registro de aplicación de 001 |

Los metadatos necesarios para índices (incluidos JID y nombre de WhatsApp) no están cifrados. No hay TTL de mensajes ni eliminación automática en esta versión: se debe definir la retención del tenant antes de un despliegue productivo. Los eventos de cambios de borrador, settings, sesión, memoria y token se guardan en el mismo documento que la mutación, evitando perder la auditoría humana entre dos escrituras. La auditoría operativa y el registro de uso son independientes; una interrupción puede dejar un intento `started` con costo desconocido. No es un ledger inmutable para cumplimiento normativo.

## Flujo implementado

1. El usuario pide conectar. La web registra el estado deseado; el worker crea un socket con credenciales de ese usuario. El QR se cifra y se entrega sólo a su dueño, convertido a imagen local, con `Cache-Control: no-store`. No se imprime en consola.
2. `creds.update` y las claves Signal se persisten usando la serialización binaria de Baileys. No se usa `useMultiFileAuthState` ni carpetas de credenciales.
3. `messages.upsert` y `messaging-history.set` pasan por la misma ingestión idempotente. Se descartan grupos, broadcasts, newsletters y exclusiones configuradas. Se guardan mensajes entrantes y salientes, sin enviar respuestas de WhatsApp.
4. Una ventana se cierra tras 3 minutos de inactividad, configurable entre 30 segundos y 30 minutos. La agrupación usa timestamps de WhatsApp; la espera usa fecha de recepción para tolerar sincronización tardía.
5. El worker analiza la conversación ordenada completa de cada ventana. El detector `manager-rules-v1` exige una mención entrante de Manager y términos de consulta/problema. Es un filtro determinista conservador, no un modelo semántico. Clasifica inicialmente Soporte Remoto y diferencia actualización, configuración, consulta y posible error. No detecta todas las tareas ni garantiza distinguir varios incidentes dentro de una ventana. Todo resultado requiere revisión.
6. Los audios se descargan y transcriben antes del análisis. Sin transcriptor, con audio vencido o ante fallo, **no se crea un borrador parcial**. La cola reintenta hasta tres veces; una solicitud histórica permite volver a intentar después de resolver el problema. Las transcripciones completadas se reutilizan.
7. Los campos incluyen fecha original, empresa/contacto, nombre, estado, vía, categoría, error tipo, descripción y acción propuesta. La memoria se aplica al generar el borrador; una relación nueva no pisa borradores ya editados.
8. La bandeja ofrece selección individual, autoguardado con revisión optimista y aprobación. Un conflicto devuelve 409; no se sobrescriben silenciosamente cambios de otra pestaña. Si llega evidencia tardía, se mantiene el texto humano y se invalida la aprobación. El usuario puede reconocer la nueva fuente tras revisarla. Si el histórico une dos ventanas ya publicadas como borradores, ambos se bloquean para conciliación futura; no se genera un tercero.

Las exclusiones del tenant se suman a las del usuario. No se precargaron nombres de personas, empresas ni relaciones de la prueba MSM. Para excluir números con identidad LID se debe registrar también ese JID cuando corresponda; la resolución automática entre LID y teléfono todavía no está implementada.

## Histórico y límites explícitos

`POST /history` recibe fechas ISO con zona horaria, intervalo `[from,to)`, hasta 31 días. Sólo encola chats con mensajes **ya sincronizados en MongoDB**. Lee el contexto completo disponible del chat para mantener límites estables aun entre rangos superpuestos. No solicita de forma garantizada todas las conversaciones antiguas del teléfono; depende de lo que entregue WhatsApp al dispositivo vinculado.

Límites de esta vertical: un worker activo, hasta 100 sesiones deseadas, un trabajo de análisis simultáneo, hasta 5.000 mensajes almacenados por chat por procesamiento, 500 mensajes / 100.000 caracteres por ventana y audios de hasta 10 minutos / 16 MiB. Ante exceso se marca error, sin truncar la conversación analizada. Un mensaje individual de más de 20.000 caracteres se registra como `contentTooLarge` sin su contenido y bloquea el análisis de esa ventana. Para producción se necesita paginar ventanas y definir un flujo de recuperación de contenido excedido.

No se soportan aún edición/revocación de mensajes WhatsApp, normalización completa LID↔teléfono, OCR, varias tareas por ventana, selección masiva, SSE/WebSocket, roles separados de aprobador, automatización de alta confianza, límites monetarios de IA ni reenvío de medios vencidos. No hay proveedor de IA remoto habilitado; los tokens se registran como cero para el detector local.

## Recuperación y concurrencia

- La migración crea índices antes de activar el módulo. Claves deterministas e índices únicos impiden duplicar ingestión por replay.
- `queued:false` permite reparar una caída entre insertar el mensaje y encolarlo.
- Un lease MongoDB de 30 segundos, renovado cada 5, selecciona un único worker. Si se pierde, se detienen sockets y procesamiento; el supervisor debe reiniciarlo. Un segundo worker no se convierte automáticamente en standby.
- Cada trabajo se reclama atómicamente, con vencimiento de 120 segundos, generación y token. Las escrituras comprueban propiedad antes de procesar/finalizar; una nueva ingestión invalida la generación anterior. Los trabajos abandonados se recuperan al vencer.
- El procesamiento local puede repetirse tras una caída; los borradores usan IDs estables y la medición registra intentos reales. No se promete exactamente una llamada al transcriptor frente a una respuesta perdida.
- Sesiones conectadas se recuperan desde MongoDB tras reiniciar. Desconectar pausa el socket y conserva credenciales para reconectar. Un logout recibido desde WhatsApp elimina la auth y obliga a vincular nuevamente.
- El worker vuelve a verificar la existencia, tenant, bloqueo y permiso del usuario al sincronizar sesiones y empezar trabajos. Una revocación detiene las sesiones en el siguiente ciclo.

Para escalar, particionar la propiedad del socket por tenant/usuario y las tareas por conversación. Mantener un único propietario de las claves Signal y agregar fencing transaccional si varios procesos escriben el mismo estado. El lease actual es una base para el piloto, no una garantía distribuida frente a pausas de proceso arbitrariamente largas durante una escritura MongoDB.

## Contrato HubSpot

La conexión queda bloqueada por defecto. Sólo para la última etapa se habilitará `SUPPORT_HUBSPOT_ENABLED=true`; mientras tanto no se muestran campos de token/IDs ni consultas de tickets, y sus endpoints devuelven `hubspot_deferred` antes de invocar al cliente remoto.

El cliente usa HTTPS a `api.hubapi.com`, Bearer sólo desde backend, timeout de 15 segundos y no sigue redirects. Expone lectura dinámica de propiedades/pipelines/estados y etiquetas de asociaciones, verificación contacto↔empresa, y búsqueda paginada de tickets asociados a empresa (hasta 1.000; si falta una página, falla explícitamente). Nunca considera un error de búsqueda como “no hay tickets”.

`prepare()` arma un payload revisable con nombres internos y asociaciones descubiertas, rechaza propiedades no escribibles y opciones inválidas, usa `createdate` sólo si es escribible y `closed_date` únicamente para un estado cerrado con fecha explícita. No se inventan IDs a partir de las etiquetas observadas. Las propiedades personalizadas de vía/categoría/error requieren mapping por tenant. El borrador conserva la fecha del mensaje aunque HubSpot no permita escribirla.

El token requiere acceso a tickets y lectura de empresas/contactos; al configurarlo se prueban las lecturas de metadatos y asociaciones. Deben verificarse scopes y disponibilidad real de cada endpoint en la cuenta elegida. Una cuenta Free no implica acceso a todas las funciones avanzadas de Service Hub. Esta entrega no se probó con una cuenta ni token reales.

Los estados y opciones de negocio aportados aparecen como ayudas de edición en la bandeja. No se confunden con los valores internos de HubSpot. “Error software” es una sugerencia del detector y requiere validación humana.

### Siguiente vertical: conciliación y publicación

Antes de habilitar cualquier envío:

1. Resolver/verificar empresa y contacto; buscar todas las tareas de la misma empresa, incluso las originadas por otros usuarios de Asisto.
2. Comparar la tarea completa con tickets existentes; decidir crear, actualizar, cerrar o ignorar. Una incertidumbre semántica o búsqueda incompleta requiere revisión, nunca creación automática.
3. Persistir un registro de tarea/outbox con unicidad **por tenant+empresa+tarea canónica**, sin `userId`, para evitar duplicados entre operadores. Definir equivalencia de tareas y versiones del análisis.
4. Vincular aprobación a versión exacta de evidencia, propuesta y ticket destino. Modificar una propuesta invalida su aprobación.
5. Preparar payload con metadatos actuales, persistir intento y sólo entonces enviar. Frente a timeout después de POST, pasar a `reconciliation_required`; no repetir la creación ciegamente. Evaluar propiedad externa de correlación escribible según la cuenta y buscarla antes de reintentar.
6. Registrar ID remoto, asociaciones y resultado. Respetar 429/Retry-After; aplicar backoff con jitter a lecturas y escrituras idempotentes. La creación remota de tickets no se trata como intrínsecamente idempotente.

Hasta implementar y probar esto, el módulo carece deliberadamente de método HTTP de creación/actualización remota. Seleccionar “create/update/close/ignore” sólo expresa la intención de un borrador.

## API de esta vertical

Base `/api/support`, cookie de Asisto. Para mutaciones: JSON, `Origin` idéntico al origen de `PUBLIC_BASE_URL` (o `SUPPORT_PUBLIC_ORIGIN` si se configuró explícitamente) y `X-Asisto-Support: 1`.

| Método y ruta | Uso |
| --- | --- |
| `GET /status` | Configuración pendiente, migración y estado del worker; nunca devuelve secretos |
| `GET /session`, `POST /session` | QR/estado propio; `desired: connected/disconnected` |
| `GET /settings`, `PUT /settings` | Preferencias y exclusiones propias |
| `PUT /tenant-settings` | Exclusiones de tenant; sólo admin/superadmin |
| `POST /history` | `{from,to}` ISO; encola rango local |
| `GET /drafts?before=<id>` | 50 borradores; cursor opaco basado en ID |
| `PATCH /drafts/:id` | `{revision,fields}`; autoguardado con compare-and-set |
| `POST /drafts/:id/approve` | `{revision}`; aprobación local |
| `POST /drafts/:id/acknowledge-source` | `{revision}`; confirma revisión de evidencia tardía no fusionada |
| `GET /jobs`, `/usage`, `/audit` | Últimos trabajos/intentos/eventos del usuario |
| `GET /capabilities` | Informa si la etapa HubSpot está habilitada |
| `GET /memory`, `PUT /memory` | Relaciones manuales `{jid,company,contact}`; no invoca APIs externas |
| `PUT /memory/verify` | Etapa final: verifica `{jid,companyId,contactId}` en HubSpot |
| `PUT /hubspot` | Admin: `{token}`; valida y cifra, nunca lo devuelve |
| `GET /hubspot/metadata` | Propiedades, pipelines y asociaciones reales |
| `GET /hubspot/companies/:id/tickets` | Consulta de tickets de empresa en el tenant conectado |

## Activación y operación

Usar Node 24 y MongoDB. El arranque habitual de Asisto (`npm start`, también `server.js`) inicia un worker como proceso hijo separado dentro del mismo servicio de Render cuando la configuración está habilitada y lista. Hereda las variables existentes; no requiere contratar otro servicio. No ejecutar migraciones contra producción desde tests. Reutilizar `MONGODB_URI`, `MONGODB_DBNAME`, `PUBLIC_BASE_URL` y `AUTH_COOKIE_SECRET` de Asisto. No hace falta crear una clave ni un dominio adicionales para soporte. El único interruptor de activación es:

```text
SUPPORT_ENABLED=true
```

Web y worker deben recibir el mismo secreto existente `AUTH_COOKIE_SECRET`, de al menos 32 caracteres y distinto del valor de desarrollo. HKDF-SHA256 deriva internamente una clave AES de 32 bytes con salt `asisto/support/v1`, contexto `session-and-content-encryption` e identificador `asisto-auth-v1`. Así se separa su uso de la firma de cookies sin administrar otro secreto. No se guardan claves en archivos versionados ni en variables públicas del frontend.

Al reutilizar el secreto de sesión, su rotación también afecta la lectura de los datos cifrados de soporte: conservar el secreto anterior y recifrar los registros antes de retirarlo. No rotarlo como una simple invalidación de cookies. El recifrado masivo sigue pendiente de un runbook específico.

Por compatibilidad, una configuración explícita previa de `SUPPORT_ENCRYPTION_KEYS` y `SUPPORT_ACTIVE_KEY` mantiene prioridad; no se cambia su cifrado automáticamente. Una configuración explícita incompleta o inválida bloquea el módulo, sin recurrir silenciosamente a otra clave. `SUPPORT_PUBLIC_ORIGIN` también se conserva como override opcional del dominio existente.

```bash
npm ci
npm run support:migrate
# Servicio existente: inicia la web y su worker supervisado:
npm start
# Sólo para operación independiente sin el supervisor web:
npm run support:worker
```

Otorgar permiso `support` en Usuarios y abrir **Tickets desde WhatsApp** en el menú lateral, o directamente `/ui/support`. El formulario de creación y el de edición de usuarios incluyen ese permiso. Los usuarios legacy con acceso completo conservan la política existente; no se amplían automáticamente listas de permisos restringidas. El panel de preparación permanece disponible aunque falte configuración. Las operaciones requieren `SUPPORT_ENABLED=true`, una clave de cookie segura, cifrado, origen válido y migración. Una configuración incompleta no impide arrancar el resto de Asisto. El supervisor reinicia el proceso ante una caída con esperas de 5 a 30 segundos y lo detiene junto con la web. El worker también se cierra si pierde el vínculo con su proceso padre. El lease evita dos propietarios durante un despliegue; el nuevo proceso reintenta hasta quedar disponible. Ambos procesos comparten los recursos del servicio de Render: revisar memoria al ampliar el piloto.

Transcriptor opcional: un gateway **local** ya operado por el tenant, compatible con este contrato:

```text
SUPPORT_TRANSCRIBER_URL=http://127.0.0.1:8090/transcribe
SUPPORT_TRANSCRIBER_MODEL=nombre-y-version-del-modelo-local
SUPPORT_TRANSCRIBER_TOKEN=<opcional, desde el gestor de secretos>
```

Recibe `POST` con bytes de audio y su Content-Type; devuelve `{"text":"transcripción"}`. Debe tener su propia capacidad y control de acceso. Se registran segundos, duración y unidades locales con costo cero; no se configura aquí un proveedor facturable. El módulo no instala ni inicia un motor de transcripción. Para audios ya fallidos, solicitar otra vez el rango histórico una vez disponible el servicio.

Rollback: desactivar el flag en la web, detener el worker y conservar las colecciones cifradas. No se eliminan ni modifican colecciones legacy. Ninguna migración hace borrados automáticos.

## Validación

`npm test` ejecuta los tests existentes y los de soporte. `npm run test:support` ejecuta sólo el módulo. Se usa un proceso MongoDB efímero real (`mongodb-memory-server`); la primera corrida necesita descargar su binario o disponer de `MONGOMS_SYSTEM_BINARY`. No usa la URI de producción.

Resultado tras integrar los cambios actuales de main: 56 pruebas aprobadas (33 de soporte y 23 existentes). Se cubren: cifrado/contexto/rotación, aislamiento, CSRF, permisos, claves binarias Baileys, QR/eventos/logout con socket simulado, exclusiones, debounce, histórico superpuesto, edición concurrente, evidencia tardía, audio pendiente/transcrito, límites de audio, métricas, reparación de cola, claims simultáneos, lease vencido y contrato HubSpot con transporte simulado. Las pruebas también verifican el menú, el shell, el editor de permisos y el diagnóstico sin secretos cuando falta configuración. Se verificaron selección, edición y aprobación local en navegador con una fixture descartable. No se han vinculado teléfonos reales, transcrito audios reales ni creado tickets remotos.

El audit de dependencias detectó 15 avisos (13 moderados y 2 críticos) en cadenas legacy de Express/qs, Telegram/request, Google y ExcelJS. No se aplicaron actualizaciones mayores ajenas a esta vertical. Evaluar esas dependencias antes de desplegar el piloto expuesto. Baileys queda fijado a `7.0.0-rc14`; validar vinculación y reconexión reales antes de producción y actualizarlo mediante un cambio probado.

Referencias consultadas el 8 de septiembre de 2026: [ejemplo oficial de Baileys](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts), código y tipos de la versión instalada; [guía oficial de tickets de HubSpot](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/tickets/guide). Las condiciones y propiedades efectivas se verifican contra la cuenta destino.
