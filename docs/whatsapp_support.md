<!-- Asisto | Version: 5.00.178 | Fecha: 2026-09-20 -->
# Tickets desde WhatsApp: agente personal en cada PC

## Revisión de objetivos 5.00.307 / extensión 1.0.61

5.00.308 completa la repartición de borradores automáticos con membresías cruzadas; la revisión explícita no reutiliza caché ni IDs archivados. Mini usa esquema estricto con una posición por mensaje. No relaja validación semántica de cierres ni protecciones humanas/HubSpot.

5.00.309 valida todos los resúmenes de la reparación antes de modificar membresías: un análisis inválido tardío no aplica cambios parciales. Registra consumo de respuestas rechazadas por la validación semántica, sin facturar éxitos ficticios.

ALSO, DEMJG y SANA agrupan ráfagas y seguimientos por objetivo, no por audio. Una segunda revisión acotada puede unir fragmentos; ambas llamadas se contabilizan. Se valida cobertura completa y resolución con cita original: un agradecimiento aislado no cierra, una confirmación explícita sí. Pruebas y avisos automáticos sin pedido no crean tarea. El panel separa estado operativo de “Sin guardar en HubSpot”. Conserva el modelo configurado.

`node scripts/review_support_generated.cjs` simula la revisión; `--apply` respalda cada borrador automático cifrado en support_audit y encola una reparación idempotente sobre sus mensajes originales. Exclusivamente ALSO/DEMJG/SANA y Cluster0. Excluye ediciones humanas, descartes y tickets guardados/enviándose/inciertos; vuelve a validar protecciones al aplicar. No llama a escrituras HubSpot, no borra mensajes ni cambia autenticación. Ante error queda reintentable sin reemplazar evidencia por inferencias.

## Agente Windows 5.00.305 — cortes de descarga

Paquete 5.00.306: para PCs ya instaladas, extraer el ZIP completo y ejecutar `Actualizar.cmd` con el mismo usuario Windows. `Actualizar.ps1` obtiene la ruta real desde la tarea del perfil existente, valida que esté bajo AsistoSupport del usuario, respalda sólo código y cambia únicamente agent.cjs, run.ps1 y el parche de medios. Mantiene rutas de perfil, cuenta, autenticación y cola cifrada, extensión, tarea programada y dependencias. Reinicia el supervisor existente y verifica un estado activo reciente; un fallo de verificación se informa sin iniciar una nueva vinculación. No es un actualizador remoto automático: debe ejecutarse en la PC correspondiente.

Baileys rc14 encadenaba el flujo HTTP de descarga con `pipe`, dejando `ECONNRESET`/`terminated` sin propagación al consumidor. `media-stream-patch.cjs` aplica antes de importar Baileys una corrección acotada a `downloadEncryptedContent`: `pipeline` destruye ambos flujos ante error y el consumidor recibe el rechazo, incluso si adjunta su iterador después del corte. Conserva copia original del módulo; es idempotente y rechaza fuentes inesperadas. No instala un manejador global que oculte excepciones. Instalador y agente incluyen la corrección aunque npm se ejecute con `--ignore-scripts`.

El supervisor, tras adquirir el mutex del perfil, recupera únicamente un proceso huérfano cuyo ejecutable, script y perfil coincidan exactamente. Conserva autenticación, cola cifrada, tareas y tickets. No ejecuta logout. Pruebas: corte ECONNRESET, consumidor tardío, siguiente descarga correcta, cancelación y regresión del agente. Distribución local/ZIP; no necesita cambio de API o Mongo.

Extensión 1.0.60 / backend 5.00.299: al desplegar los datos de empresa consulta `GET /api/support/extension/hubspot/company-contacts?id=...` con integración del tenant. Muestra nombre, cargo, email, teléfono y celular de contactos realmente asociados por `associations.company`. Paginación de 100 hasta 1000, con aviso de lista parcial; errores no ocultan la empresa ni alteran borradores. Sólo consulta al expandir; ignora respuestas de una selección anterior. Sin escritura en HubSpot ni envío automático.

Extensión 1.0.59: cabecera compacta y fija con logo, contacto activo y botones de actualizar/configurar. Campos en dos columnas (una en panel muy estrecho), descripción reducida y redimensionable, identificadores de HubSpot desplegables. Conserva los controles, valores, borradores y guardado existentes. Empresa y condición de abonado permanecen visibles; no abonado conserva indicador rojo.

## Destinatarios Manager — 5.00.298 / extensión 1.0.58

El compositor ofrece un listado explícito de contactos de HubSpot con email terminado exactamente en `@managersistemas.com`, sin duplicados, y conserva el ingreso manual. GET `/api/support/extension/hubspot/mail-contacts` usa la integración del tenant autenticado, busca páginas de 100 hasta 1000 resultados y devuelve `{contacts:[{name,email}],incomplete}`. La interfaz avisa ante resultados parciales o error; nunca elige ni envía automáticamente.

Los nuevos borradores de correo incluyen empresa y contacto de la edición vigente y fecha/hora de `fields.messageDate` (fecha de conversación utilizada para el ticket), en `America/Argentina/Buenos_Aires`. Si falta se indica «No disponible»; no se inventa la hora actual. Los borradores de correo existentes se conservan. El contenido se revisa antes de confirmar. Pruebas: directorio paginado/dominio exacto y DOM de selección, entrada manual, fecha y confirmación.

## Correo SMTP por usuario — 5.00.297 / extensión 1.0.56

Extensión 1.0.57: el engranaje junto a Actualizar abre Configuración, con correo por usuario y exclusiones de contactos. Ambos controles dejan de ocupar permanentemente la vista de tareas; se conservan nodos, campos, listeners y estado al abrir/cerrar, sin recargar tareas. Cerrar o Escape vuelve al engranaje y vacía solamente la contraseña SMTP aún escrita, no la cifrada en servidor. No cambia autenticación ni configuración persistida.

Configuración desde el desplegable de correo en la extensión, disponible a cada usuario habilitado de soporte (no se configura una cuenta global). Servidor público con IPv4, puerto 465 TLS o 587 STARTTLS obligatorio, usuario, contraseña/app password, dirección y nombre remitente. Gmail/Outlook u otros proveedores pueden requerir contraseña de aplicación y habilitar autenticación SMTP; no se implementa OAuth ni relays de LAN. Conexión sale de AWS, no de la PC. AWS/proveedor pueden bloquear SMTP. Verificar conexión autentica sin enviar correo; configurar no envía mensajes. No hay correos de prueba automáticos ni envío real durante validación de desarrollo.

Rutas autenticadas por dispositivo/sesión/origen: GET/POST `/api/support/extension/mail/settings`, POST `/mail/verify`, GET/POST `/drafts/:id/mail` bajo el mismo prefijo. Sólo dueño de tenant/user y tarea. Contraseña cifrada AES-GCM en `support_mail_settings.payload` con AAD de dueño; GET jamás devuelve contraseña. Vacío conserva únicamente si servidor/usuario siguen iguales. No se guarda contraseña en almacenamiento Chrome, logs ni auditoría. Cambiar usuario limpia formulario. DNS sólo público y fijado a IP tras validación, sin rangos privados, loopback, link-local/metadatos ni Tailscale; TLS valida certificado y hostname. Sin lectura de archivos/URL ni adjuntos arbitrarios.

Botón por tarea abre asunto/descripción editados como correo de texto plano. Destinatario explícito con sugerencias HubSpot, nunca asignado automáticamente; revisar y confirmar por separado. No guarda ni modifica tarea/estado/ticket; registro en Asisto asociado al draft y ticket existente, no añade nota HubSpot. Borrador de correo por dueño/tarea en sesión Chrome, sin tocar borrador del editor. No soporta adjuntos en esta primera versión.

Intentos en `support_mail_attempts` con contenido cifrado, identificador idempotente, estado sending/accepted/rejected/uncertain y fechas; últimas 10 entradas por tarea. Accepted significa aceptación SMTP, no entrega efectiva. Ante timeout/resultado ambiguo no hay reintento automático; repetir mismo identificador no reenvía. Editar contenido habilita un intento nuevo con confirmación explícita. Hasta 30 intentos por hora/usuario y separación mínima de 3s; verificación cada 10s. No reescribe eventos ni usa IA/tokens. Índices aditivos por dueño y tarea, sin eliminación de datos históricos. Pruebas con transporte simulado (ningún correo real), aislamiento/API, cifrado, TLS/SSRF, idempotencia, rechazo/timeout y DOM de confirmación/conservación de tareas.

## Agrupación por objetivo (2026-10-05)

Protección v5.00.285: en ALSO/DEMJG/SANA, la cola automática excluye de cualquier nueva asignación la evidencia de un ticket que ya tiene ID HubSpot o estado saved. Los mensajes nuevos se procesan en un borrador independiente, aun si la IA los agrupó con un asunto anterior. El ticket guardado, sus campos, estado, revisión y evidencia quedan intactos. Actualizarlo requiere la acción explícita existente del usuario; envíos inciertos o en curso siguen bloqueando procesamiento. No repara automáticamente asociaciones históricas anteriores. Regresión: un modelo que agrupa impresión y caja no puede modificar el ticket guardado; las continuaciones del borrador nuevo no lo duplican. 48 pruebas aprobadas.

Optimización incremental v5.00.282: la caché conserva huellas por mensaje. Si la evidencia previa es un prefijo idéntico, la siguiente consulta contiene un resumen de hasta 1000 caracteres por grupo, los dos últimos mensajes de ese grupo (hasta 600 caracteres cada uno) y los mensajes nuevos completos. La respuesta se expande a los identificadores originales antes de modificar borradores. Un bloque anterior es indivisible; no se pierden mensajes. Si cambia evidencia anterior, llega historia intercalada o cambia el período se usa análisis completo. La primera consulta después de migrar la caché también es completa. No cambia modelos, audios, estados, HubSpot ni límites de protección; los resúmenes finales de las tareas mantienen el contexto completo. Pruebas focalizadas: 47 aprobadas. El ahorro real depende de la longitud y actividad de las conversaciones; no es una reducción del consumo ya facturado.

ALSO, DEMJG y SANA usan el modelo configurado de Tareas WhatsApp (por defecto gpt-4o-mini) para agrupar la conversación elegible completa por problema u objetivo antes de generar títulos. Las transcripciones se reutilizan. Pasos de facturación, precios, filtros y códigos no se separan por una pausa o por decir «también»/«además»; sólo solicitudes independientes justifican varias tareas. La salida debe asignar cada mensaje exactamente una vez, sin índices inventados: una salida inválida deja los borradores intactos y el trabajo sujeto a reintentos limitados.

Se conserva una caché por contacto/usuario y huella de evidencia en `support_contacts.taskGrouping`. La clasificación se registra en `ai_token_usage_log` como `whatsapp_task_summary`, fuente `support_task_grouping`; no agrega una llamada si los mensajes no cambiaron. Límite explícito: 500 mensajes / 100.000 caracteres serializados por análisis, sin truncado silencioso. Conversaciones mayores requieren un período acotado.

Se mantiene la protección existente de ediciones, descartes y envíos HubSpot: sólo borradores automáticos compatibles se consolidan. Varias tareas editadas no se fusionan automáticamente. No se escriben tickets en HubSpot por reagrupar. Otros dominios conservan la agrupación anterior. La agrupación nueva se aplica al procesar mensajes/períodos; no hay reprocesamiento masivo automático. Pruebas: `support_task_grouping`, `support_title_analyzer`, `support_integration`.

## Arquitectura acordada

**Baileys corre en la PC de cada usuario, en un proceso propio.** Render aloja el panel y la API de Asisto; no inicia sockets de WhatsApp ni un worker compartido. Se retiraron el supervisor y el comando del worker de servidor introducidos en 5.00.052. Las integraciones preexistentes continúan independientes.

El agente de Windows se instala una vez por perfil y se inicia automáticamente al ingresar a Windows, aunque el navegador esté cerrado. La PC debe permanecer encendida y con Internet. No se ejecuta Baileys dentro del navegador. Cada instalación tiene un perfil local y un proceso independiente; cuentas distintas pueden funcionar simultáneamente en PCs distintas. Una cuenta de Asisto autoriza una PC activa a la vez.

La extensión puede publicar tickets mediante la aplicación privada de HubSpot. El token vive sólo en el backend y nunca se carga en la extensión, el navegador ni el panel de Asisto.

## Instalación y autorización

1. Ingresar a Asisto y abrir **Sesiones WhatsApp Web**, `/admin/wweb`. La sección personal muestra únicamente la PC y el QR del usuario autenticado. Los permisos `support` permiten esta sección; las APIs y controles legacy siguen requiriendo `wweb`.
2. Descargar `AsistoTareas-5.00.178.zip`, descomprimirlo y ejecutar `Instalar.cmd` en la PC del usuario.
3. El instalador prepara un runtime privado Node 24.12.0, verifica el SHA256 del ZIP oficial, instala con el lockfile las dependencias de Baileys y configura el inicio automático. No incluye `node_modules` ni requiere administrador.
4. El mismo instalador copia la extensión a `%LOCALAPPDATA%\AsistoSupport\Extension` y deja el acceso directo **Extension Asisto** en el Escritorio. Chrome exige que el usuario abra `chrome://extensions`, active Modo de desarrollador y confirme **Cargar descomprimida** sobre esa carpeta. Si ya estaba cargada, se pulsa **Recargar**.
5. El usuario ingresa normalmente a Asisto y abre **Sesiones WhatsApp Web → Escanear mi QR → Vincular / reconectar**. La web consulta exclusivamente `http://127.0.0.1:17658/pairing` y asocia el agente pendiente con la cuenta autenticada. El navegador puede pedir permiso de acceso local. No hay acceso de escritorio ni aperturas automáticas de páginas o diálogos.
6. El agente inicia Baileys automáticamente y el panel muestra el QR para escanear desde WhatsApp → Dispositivos vinculados.
7. Las siguientes sesiones de Windows recuperan el proceso y las credenciales locales; no necesitan otra instalación ni un QR salvo que WhatsApp cierre la vinculación.

La instalación inicial y el escaneo requieren al usuario. El clic en Vincular / reconectar autoriza la PC; no se ingresan códigos ni otra contraseña. El puente local sólo escucha en loopback y exige origen exacto de Asisto, Host de loopback y encabezado propio; no expone tokens ni credenciales de WhatsApp. Un agente ya asociado a otra cuenta se rechaza, comparando usuario y dominio. No se copian claves de Render, MongoDB ni OpenAI a las PCs.

`Desvincular mi PC` revoca su acceso a Asisto. Para desactivar también el arranque, deshabilitar la tarea `AsistoSupport-<perfil>` en el Programador de tareas. Se ejecuta al iniciar sesión con la cuenta actual de Windows, token interactivo y privilegios limitados, sin contraseña adicional. No tiene límite de duración, permite batería y evita instancias duplicadas. El supervisor reinicia el agente si termina inesperadamente.

Reinstalar conserva el único perfil existente de esa cuenta de Windows; registra la tarea antes de retirar el inicio anterior en HKCU Run y sustituye sólo los procesos de ese perfil. Si Windows impide registrar tareas, el instalador informa el error y conserva el arranque anterior. No hay borrado automático de conversaciones. Los enlaces de vinculación anteriores siguen aceptándose por compatibilidad; ningún agente abre el navegador. El puente local admite un perfil activo por PC.

## Componentes

| Componente | Función |
| --- | --- |
| `desktop/support/agent.cjs` | Proceso local por usuario, emparejamiento, Baileys, reconexión y cola de envío |
| `storage.cjs`, `protect.ps1` | Archivos AES-GCM y clave local protegida con DPAPI CurrentUser |
| `Instalar.ps1`, `run.ps1` | Runtime verificado, instalación sin administrador, tarea de inicio y preparación de la extensión |
| `src/support/devices.js` | Autorización de PCs, identidad autenticada, lease por usuario y API limitada |
| `routes.js`, `panel.html`, `static/support.*` | Panel dentro de Asisto, QR y revisión de borradores |
| `service.js`, `core.js` | Exclusiones, ingestión idempotente, cola, análisis y revisión por usuario |
| `crypto.js`, `config.js` | Reutilización de configuración y cifrado de datos guardados en Asisto |
| `migration.js` | Índices aditivos de las colecciones `support_*` |

Los adaptadores de `src/support/baileys.js` permanecen como utilidades de compatibilidad y pruebas; el arranque de producción no los ejecuta. El proceso efectivo está en `desktop/support/agent.cjs`.

## Configuración existente

Se reutilizan `MONGODB_URI`, `MONGODB_DBNAME`, `PUBLIC_BASE_URL` y `AUTH_COOKIE_SECRET`. `SUPPORT_ENABLED=true` habilita la API y el panel operativo, sin iniciar un worker en Render. `PUBLIC_BASE_URL` debe coincidir con el origen real: `https://asistobot.com.ar`. Se mantiene el inicio de sesión existente de Asisto.

Para HubSpot, en Render abrir el servicio **webhooks**, entrar en **Environment** y agregar `SUPPORT_HUBSPOT_ENABLED=true`, `HUBSPOT_TENANT_ID=ALSO` y `HUBSPOT_PRIVATE_APP_TOKEN` como valor secreto. En una instalación con varias cuentas se usa `HUBSPOT_PRIVATE_APP_TOKEN_<TENANT>`, por ejemplo `HUBSPOT_PRIVATE_APP_TOKEN_ALSO`; `HUBSPOT_PORTAL_ID_<TENANT>` es opcional. No guardar estos valores en Dominio Config. La aplicación privada requiere `tickets`, `crm.objects.companies.read` y `crm.objects.contacts.read`.

Antes de cualquier escritura, Asisto valida la cuenta, propiedades internas del ticket, pipelines y etapas, búsquedas de empresas y contactos y tipos de asociación. Un 401 se informa como credencial inválida y un 403 como permisos insuficientes. La publicación conserva un bloqueo por borrador y registra el usuario, tenant y resultado en auditoría.

El cifrado del servidor deriva una clave AES de 32 bytes con HKDF-SHA256, salt `asisto/support/v1` y contexto `session-and-content-encryption`. Selecciona el primer secreto existente de al menos 32 caracteres entre `AUTH_COOKIE_SECRET`, `WWEB_API_KEY` y `OPENAI_API_KEY`, con IDs `asisto-auth-v1`, `asisto-wweb-v1` y `asisto-openai-v1`. Todos los candidatos disponibles permanecen en el keyring para leer registros anteriores. Esta derivación es local: no llama a la API ni consume créditos.

**La rotación de la variable seleccionada también afecta los datos cifrados de soporte.** Conservar el valor anterior y planificar el recifrado antes de retirarlo. No hay recifrado masivo automático. Una instalación con `SUPPORT_ENCRYPTION_KEYS` / `SUPPORT_ACTIVE_KEY` explícitos mantiene esa configuración y no cambia silenciosamente a otra clave. El valor de cookie de desarrollo sigue bloqueado.

El agente obtiene su credencial de dispositivo automáticamente durante el emparejamiento y la guarda cifrada en Windows. No es una variable global que el administrador deba crear. Las credenciales de Baileys permanecen en la PC.

## Identidad y aislamiento

- El emparejamiento expira a los 10 minutos, tiene código aleatorio y límites de frecuencia. El servidor guarda sólo el hash del token secreto.
- La aprobación requiere cookie de Asisto, permiso `support`, origen exacto y `X-Asisto-Support: 1`. Tenant y usuario proceden de la sesión, nunca del formulario.
- Autorizar reemplaza sólo la PC anterior de ese usuario. Un índice parcial permite una sola PC aprobada por tenant/usuario.
- Cada petición comprueba token, usuario, bloqueo y permiso. La credencial aprobada expira al año y puede revocarse antes.
- Un lease de 30 segundos por tenant/usuario distingue procesos mediante un identificador de instancia. Usuarios diferentes tienen leases simultáneos. Un proceso anterior no puede escribir luego de perder su lease.
- El agente usa endpoints específicos, sin acceso general a MongoDB. Colas y trabajos se filtran por el propietario autenticado.
- Archivos locales cifrados con nonces aleatorios y contexto por registro; DPAPI liga la clave a la cuenta de Windows. El perfil tiene ACL para el usuario y SYSTEM.

Los metadatos de índices, como JID y nombre de WhatsApp, no se cifran en MongoDB. Los cuerpos, QR y borradores sí. Definir retención antes de ampliar el uso; no hay TTL de mensajes.

## Flujo y límites

La cola local puede contener historial anterior al período elegido. Ese total se muestra separado del resultado de Procesar. El agente prioriza mensajes recientes, sube lotes de hasta 25 mensajes/110 KB y cede ejecución durante la importación para mantener activa su conexión.

Los mensajes históricos se guardan sin disparar análisis automático fuera de los períodos solicitados. Procesar conserva la solicitud durante 30 días y agrega los mensajes del rango que lleguen después. El resultado y el estado aparecen junto al botón; los trabajos del período usan únicamente mensajes dentro de sus fechas. Los mensajes nuevos posteriores a la vinculación siguen el flujo automático.

El agente recibe mensajes entrantes, salientes e historial, omitiendo grupos, broadcasts y newsletters. Conserva una cola local cifrada para reintentar entregas. El backend aplica exclusiones del usuario y tenant y deduplica por propietario, chat, ID y dirección.

Se agrupan ventanas tras 3 minutos de inactividad (30 segundos a 30 minutos configurables). El agente solicita procesar trabajos únicamente de su usuario. El criterio `support-documentation-v3` documenta todos los intercambios no vacíos que superaron las exclusiones del usuario y tenant, incluso sin mencionar Manager o sin palabras clave. Propone categoría y tipo de error con los nombres existentes de HubSpot. Las propuestas siguen basadas en reglas y requieren revisión; no se infieren empresa, identidad ni resolución. La versión del análisis permite recuperar descartes antiguos al reprocesar el mismo período, conservando las ediciones humanas.

Los borradores admiten nombres manuales de empresa/contacto y aprobación sin HubSpot. Se usa revisión optimista; evidencia tardía invalida la aprobación sin pisar ediciones. La memoria manual elimina verificaciones remotas anteriores.

El histórico procesa mensajes ya sincronizados, hasta 31 días por solicitud; no garantiza recuperar todos los chats antiguos del teléfono. Límites actuales: 5.000 mensajes por chat, ventanas de 500 mensajes / 100.000 caracteres. Un mensaje excesivo bloquea su ventana.

La transcripción reutiliza `transcribeAudioExternal` de Asisto, la clave del canal del tenant (o `OPENAI_API_KEY` existente) y el modelo de `tenant_config` con los mismos valores de respaldo. Un gateway `SUPPORT_TRANSCRIBER_URL` explícito conserva prioridad. Las claves permanecen en el servidor; no se envían a las PCs. Los audios se descargan con límites de tamaño y tiempo, se transcriben una vez y se conserva el texto cifrado con su consumo. Una transcripción vacía o fallida deja la conversación pendiente, sin omitir el audio. Los trabajos anteriores que fallaron por falta de proveedor se reactivan una sola vez por usuario. La prueba real debe comprobar registros de transcripción exitosa; pasar pruebas con datos simulados no acredita audio real.

No se soportan aún edición/revocación de mensajes, resolución completa LID↔teléfono, OCR, varias tareas semánticas por ventana ni publicación masiva. Validar un contacto permitido, uno excluido, reconexión real y un período corto antes de ampliar el volumen.

## API del agente

Base `/api/support/device`:

| Ruta | Autorización y función |
| --- | --- |
| `POST /start` | Solicitud limitada y temporal de una PC |
| `POST /poll` | Token del dispositivo; consulta aprobación |
| `GET /request/:code` | Usuario de Asisto; muestra la PC antes de autorizar |
| `POST /approve`, `/revoke` | Usuario + CSRF; autoriza/revoca su PC |
| `POST /heartbeat` | Token + instancia; adquiere/renueva lease propio |
| `POST /session` | Token + lease; publica estado y QR propios |
| `POST /messages` | Token + lease; entrega mensajes del propietario autenticado |
| `POST /work` | Token + lease; procesa un trabajo de ese usuario |

La API de revisión permanece en `/api/support`. `/status` informa el agente de la PC del usuario, no un worker global. HubSpot se habilita únicamente cuando la variable del backend está activa y existe una credencial para el tenant.

## Compilación, pruebas y despliegue

`scripts/build_support_desktop.ps1` produce `static/downloads/AsistoTareas-5.00.178.zip` con el agente y la extensión desde listas explícitas, sin `.env`, perfiles, claves ni `node_modules`. El instalador ejecuta `npm ci --omit=dev --ignore-scripts` con su lockfile.

Ejecutar `npm test`, `npm run support:migrate` y desplegar la web normalmente. La migración es aditiva y repetible; incorpora índices de dispositivos con expiración y unicidad por usuario. Los tests usan MongoDB efímero.

Se prueban emparejamiento/CSRF, usuarios simultáneos, reemplazo/revocación, recuperación de lease, aislamiento de mensajes/trabajos, DPAPI en Windows y los flujos previos. Las dependencias del instalador no reportaron vulnerabilidades en la validación. La vinculación y reconexión reales con WhatsApp requieren el teléfono del usuario.

Rollback: desactivar `SUPPORT_ENABLED`, revocar la PC o deshabilitar su inicio de Windows. Para detener sólo HubSpot, desactivar `SUPPORT_HUBSPOT_ENABLED` o retirar su variable secreta. Conservar perfiles y colecciones cifradas hasta decidir su retención.

La bandeja muestra por defecto borradores para revisar. El selector Mostrar permite consultar los descartados y todas las conversaciones, con contacto y fecha. Un descarte anterior explica el cambio de criterio y permite consultar los mensajes de origen, incluso para registros anteriores; no abre un formulario vacío. La evidencia tardía actualiza campos generados automáticamente sólo si no hubo intervención humana.

Ejemplo de referencia: un cliente pide un totalizador de gastos por cuenta y período y recibe orientación sobre sumas y saldos e interfaz contable. Se documenta como Soporte Remoto / Consulta / Capacitacion, En Proceso. La promesa de enviar un video no acredita envío ni cierre resuelto.

Las pausas de inactividad sólo controlan cuándo procesar. La agrupación reúne solicitudes, respuestas y confirmaciones tardías; una nueva solicitud explícita de otro tema inicia otro grupo. Los fragmentos generados se consolidan sin borrarlos (estado merged y vínculo al borrador principal). Si hay varias ediciones humanas incompatibles, se conserva todo y se exige reconciliación. Los contactos se sincronizan desde la agenda/nombre de perfil de WhatsApp por usuario, con alias LID/PN, sin usar el nombre propio de mensajes salientes. Se rellenan contactos vacíos; los nombres manuales existentes se conservan.
## Ficha de empresa en extensión 1.0.54 (5.00.296)

Extensión 1.0.55: se retira el selector manual visible de contactos. La navegación depende del chat activo de WhatsApp; se conserva el estado interno del contacto para no alterar selección de tareas, ficha de empresa ni protección de ediciones. Las indicaciones del panel ya no piden elegir en el desplegable. ZIP `AsistoChrome-1.0.55.zip` y carpeta habitual Z:.

Disponible para todos los usuarios habilitados de Tickets WhatsApp con conexión HubSpot. `GET /api/support/extension/hubspot/company?id=<companyId>` consulta con la credencial del dominio y devuelve únicamente nombre, tipo_cliente, cod_cliente, dirección, localidad, teléfonos y dominio web. Sin ID se admite `jid` y se resuelve memoria del usuario/contacto y aliases; ante asociaciones contradictorias no se elige una empresa. También funciona sin tareas pendientes si existe una asociación guardada. Conserva el control de dispositivo/sesión y no permite acceso desde content scripts WhatsApp a esta acción.

La ficha muestra el valor exacto `tipo_cliente`: Abonado verde, No Abonado rojo; Abonado (consulta), Baja, ¡¡Consultar!! y demás valores quedan explícitos y neutrales. Ausencia de valor es Sin dato, nunca No Abonado. Detalle desplegable y enlace al portal configurado. Lectura sin IA, sin modificar empresas ni tareas; errores no bloquean edición ni publicación. Caché del panel aislada por dueño, máximo 30 entradas y 2 minutos, con promesas compartidas. Cambio de contacto invalida respuestas en vuelo; editar nombre de empresa oculta información anterior hasta seleccionar una asociación verificada. No se reemplazan campos del editor por la respuesta.

Distribución: carpeta habitual Z: y `static/downloads/AsistoChrome-1.0.54.zip`. Guardar ediciones y terminar selecciones antes de recargar extensión/WhatsApp; no desinstalar ni borrar sesiones. Pruebas API de categorías/aliases/aislamiento y DOM de carreras, caché, texto seguro y preservación de edición.

## Rendimiento de extensión 1.0.53 (5.00.294)

Agenda deduplicada por alias e índices reutilizables de teléfono/nombre evitan reconstruir y recorrer toda la agenda por cada chat. La sincronización de nombres agrupa lotes secuenciales, conserva su caché separada de nombres visibles y actualiza el índice una vez al finalizar. Consultas concurrentes de índice o mensajes comparten la operación en curso; después de asignar mensajes se solicita lectura nueva. Conserva guardas de usuario, chat y respuesta atrasada.

El observador ignora cambios fuera de WhatsApp, escritura en el compositor y elementos propios. El scroll sin cambios de contenido sólo reposiciona casilleros. La pestaña oculta pausa consultas periódicas; vuelve a consultar al mostrarse. El agente local sigue sincronizando independientemente. Se mantiene el estado de casilleros y el almacenamiento de borradores del panel; no se modifican tareas ni HubSpot para instalar la mejora. Las pruebas comprueban agenda repetida sin crecimiento, menos recorridos, consultas agrupadas, cambio de visibilidad y conservación de ediciones/selecciones.

Distribución en la carpeta habitual de Z: y ZIP `AsistoChrome-1.0.53.zip`. Reemplazar archivos no recarga la extensión activa. Para activarla se recarga desde el administrador de extensiones y después WhatsApp; antes deben guardarse las ediciones y terminarse las selecciones que aún no forman una tarea, porque recargar un contexto anterior no conserva necesariamente su memoria temporal. No se desinstala ni se borran perfiles o sesiones. No se afirma una reducción concreta de MB sin medición comparable posterior.

## Validación de cobertura de agrupación (5.00.293)

El agrupador recibe el número exacto de mensajes e índices esperados. Si la respuesta omite, repite o inventa índices, se admite una sola corrección con diagnóstico de índices faltantes y la misma evidencia. Ambas llamadas se registran en consumo. Sólo una respuesta con cobertura completa puede generar tareas; un segundo error mantiene el trabajo fallido con reintentos de cola acotados. No se inventan pertenencias de mensajes para completar la respuesta.

## Reconexión y continuidad sin repetición (5.00.292)

ALSO, DEMJG y SANA conservan un punto de continuidad por usuario (`support_sessions.historyResumeAt`), capturado antes de recibir el historial de una nueva conexión. Se recuperan mensajes desde la última fecha sincronizada aunque hayan pasado varios días. Para una primera conexión sin evidencia previa se inicia con el último día; los períodos históricos anteriores siguen disponibles mediante solicitud explícita.

Los mensajes aceptados conservan su punto de continuidad (`support_messages.historyResumeAt`) para que otra reconexión no invalide trabajo pendiente. Los IDs de WhatsApp ya recibidos no vuelven a encolar análisis; las tareas guardadas, descartes y ediciones siguen protegidos. Ingesta, procesamiento y recuperación de cola validan también las marcas históricas heredadas. Corrige la ventana fija de 24 días de versiones previas, sin imponer 24 horas a usuarios que ya tenían sincronización.

`scripts/repair_support_history_import.cjs` revisa un incidente delimitado por usuario y fechas, con `--boundary` explícito y modo de consulta por defecto. `--apply` archiva únicamente borradores pendientes no editados, no enviados a HubSpot y cuya evidencia completa es historial anterior al punto de continuidad. Conserva mensajes, campos y copias cifradas en `support_audit`; compara revisión antes de modificar y admite reejecución. No afecta borradores anteriores al incidente ni solicitudes con mensajes nuevos. Las marcas `catchup` incorrectas se corrigen conservando respaldo. La reversión de estados y marcas puede recuperarse desde esas copias; no borra documentos ni recalcula cargos históricos.

## Consolidación respaldada por evidencia (5.00.287)

Para ALSO, DEMJG y SANA, las conversaciones de hasta 12.000 caracteres se agrupan con todos sus mensajes originales. Las mayores conservan compresión incremental con extractos originales del inicio y final de cada objetivo, no títulos/descripciones generados. La caché tiene versión y una migración invalida la compresión anterior. Las pausas, pruebas, códigos de cliente y respuestas con datos no constituyen tareas independientes. Los avisos automáticos de horario por sí solos se conservan como ignorados, sin tarea accionable.

El resumen exige respaldo explícito en la evidencia y no presupone contraseñas, llamadas o soluciones típicas. No trunca silenciosamente el principio de la conversación; más de 100.000 caracteres exige revisar la ventana. Un agradecimiento por sí solo no cierra el estado automático. Los estados y campos editados por una persona y los tickets guardados mantienen su protección. Se consolida sin borrar evidencia (merged); no se reprocesa masivamente ni se modifica HubSpot. Modelo y tarifas sin cambios. Pruebas incluyen consolidación de fragmentos, tickets protegidos, aviso automático y cierre conservador.

## Detección y selección (5.00.286 / extensión 1.0.52)

ALSO, DEMJG y SANA excluyen la evidencia ya registrada en HubSpot antes de agrupar solicitudes nuevas. La exclusión no cambia tickets ni ediciones existentes; la asignación manual sigue disponible. Evita enviar historia ya atendida al agrupador y reduce su consumo. Los descartes humanos se conservan. Un fallo de agrupación sigue siendo un error, nunca una autorización para inventar tareas.

La extensión vuelve a conectar los casilleros cuando WhatsApp reemplaza el contenedor del chat. Seleccionar y crear una tarea manual no exige tareas pendientes previas. Pruebas de DOM cubren reconstrucción del chat y creación manual sin tareas; integración comprueba que evidencia guardada no llega al agrupador ni se modifica.

# Recuperación de procesamiento en vivo (5.00.277)

Un trabajo que se ejecuta antes de completar la inactividad del último mensaje se reprograma para esa fecha y permanece pendiente. No se contabiliza como terminado sin analizar la conversación. La extensión toma el nombre visible del contacto y descarta los textos de ayuda del encabezado de WhatsApp. Se verifica mediante pruebas de ejecución anticipada y encabezados con tooltip.
