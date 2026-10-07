<!-- Asisto | Version: 5.00.178 | Fecha: 2026-09-20 -->
# Tickets desde WhatsApp: agente personal en cada PC

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
## Detección y selección (5.00.286 / extensión 1.0.52)

ALSO, DEMJG y SANA excluyen la evidencia ya registrada en HubSpot antes de agrupar solicitudes nuevas. La exclusión no cambia tickets ni ediciones existentes; la asignación manual sigue disponible. Evita enviar historia ya atendida al agrupador y reduce su consumo. Los descartes humanos se conservan. Un fallo de agrupación sigue siendo un error, nunca una autorización para inventar tareas.

La extensión vuelve a conectar los casilleros cuando WhatsApp reemplaza el contenedor del chat. Seleccionar y crear una tarea manual no exige tareas pendientes previas. Pruebas de DOM cubren reconstrucción del chat y creación manual sin tareas; integración comprueba que evidencia guardada no llega al agrupador ni se modifica.

# Recuperación de procesamiento en vivo (5.00.277)

Un trabajo que se ejecuta antes de completar la inactividad del último mensaje se reprograma para esa fecha y permanece pendiente. No se contabiliza como terminado sin analizar la conversación. La extensión toma el nombre visible del contacto y descarta los textos de ayuda del encabezado de WhatsApp. Se verifica mediante pruebas de ejecución anticipada y encabezados con tooltip.
