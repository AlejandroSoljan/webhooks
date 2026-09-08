<!-- Asisto | Version: 5.00.067 | Fecha: 2026-09-08 -->
# Tickets desde WhatsApp: agente personal en cada PC

## Arquitectura acordada

**Baileys corre en la PC de cada usuario, en un proceso propio.** Render aloja el panel y la API de Asisto; no inicia sockets de WhatsApp ni un worker compartido. Se retiraron el supervisor y el comando del worker de servidor introducidos en 5.00.052. Las integraciones preexistentes continúan independientes.

El agente de Windows se instala una vez por perfil y se inicia automáticamente al ingresar a Windows, aunque el navegador esté cerrado. La PC debe permanecer encendida y con Internet. No se ejecuta Baileys dentro del navegador. Cada instalación tiene un perfil local y un proceso independiente; cuentas distintas pueden funcionar simultáneamente en PCs distintas. Una cuenta de Asisto autoriza una PC activa a la vez.

HubSpot queda para la última etapa. No se pide su token, no se llama su API ni se publican tickets con la configuración actual. La aprobación de borradores se guarda en Asisto y no autoriza futuros envíos automáticamente.

## Instalación y autorización

1. Ingresar a Asisto y abrir **Sesiones WhatsApp Web**, `/admin/wweb`. La sección personal muestra únicamente la PC y el QR del usuario autenticado. Los permisos `support` permiten esta sección; las APIs y controles legacy siguen requiriendo `wweb`.
2. Descargar el ZIP, descomprimirlo y ejecutar `Instalar.cmd` en la PC del usuario.
3. El instalador prepara un runtime privado Node 24.12.0, verifica el SHA256 del ZIP oficial e instala las dependencias fijadas. No requiere administrador.
4. El usuario ingresa normalmente a Asisto y abre **Sesiones WhatsApp Web → Escanear mi QR → Vincular / reconectar**. La web consulta exclusivamente `http://127.0.0.1:17658/pairing` y asocia el agente pendiente con la cuenta autenticada. El navegador puede pedir permiso de acceso local. No hay acceso de escritorio ni aperturas automáticas de páginas o diálogos.
5. El agente inicia Baileys automáticamente y el panel muestra el QR para escanear desde WhatsApp → Dispositivos vinculados.
6. Las siguientes sesiones de Windows recuperan el proceso y las credenciales locales; no necesitan otra instalación ni un QR salvo que WhatsApp cierre la vinculación.

La instalación inicial y el escaneo requieren al usuario. El clic en Vincular / reconectar autoriza la PC; no se ingresan códigos ni otra contraseña. El puente local sólo escucha en loopback y exige origen exacto de Asisto, Host de loopback y encabezado propio; no expone tokens ni credenciales de WhatsApp. Un agente ya asociado a otra cuenta se rechaza, comparando usuario y dominio. No se copian claves de Render, MongoDB ni OpenAI a las PCs.

`Desvincular mi PC` revoca su acceso a Asisto. Para desactivar también el arranque, deshabilitar la tarea `AsistoSupport-<perfil>` en el Programador de tareas. Se ejecuta al iniciar sesión con la cuenta actual de Windows, token interactivo y privilegios limitados, sin contraseña adicional. No tiene límite de duración, permite batería y evita instancias duplicadas. El supervisor reinicia el agente si termina inesperadamente.

Reinstalar conserva el único perfil existente de esa cuenta de Windows; registra la tarea antes de retirar el inicio anterior en HKCU Run y sustituye sólo los procesos de ese perfil. Si Windows impide registrar tareas, el instalador informa el error y conserva el arranque anterior. No hay borrado automático de conversaciones. Los enlaces de vinculación anteriores siguen aceptándose por compatibilidad; ningún agente abre el navegador. El puente local admite un perfil activo por PC.

## Componentes

| Componente | Función |
| --- | --- |
| `desktop/support/agent.cjs` | Proceso local por usuario, emparejamiento, Baileys, reconexión y cola de envío |
| `storage.cjs`, `protect.ps1` | Archivos AES-GCM y clave local protegida con DPAPI CurrentUser |
| `Instalar.ps1`, `run.ps1` | Runtime verificado, instalación sin administrador, inicio HKCU y reinicio |
| `src/support/devices.js` | Autorización de PCs, identidad autenticada, lease por usuario y API limitada |
| `routes.js`, `panel.html`, `static/support.*` | Panel dentro de Asisto, QR y revisión de borradores |
| `service.js`, `core.js` | Exclusiones, ingestión idempotente, cola, análisis y revisión por usuario |
| `crypto.js`, `config.js` | Reutilización de configuración y cifrado de datos guardados en Asisto |
| `migration.js` | Índices aditivos de las colecciones `support_*` |

Los adaptadores de `src/support/baileys.js` permanecen como utilidades de compatibilidad y pruebas; el arranque de producción no los ejecuta. El proceso efectivo está en `desktop/support/agent.cjs`.

## Configuración existente

Se reutilizan `MONGODB_URI`, `MONGODB_DBNAME`, `PUBLIC_BASE_URL` y `AUTH_COOKIE_SECRET`. `SUPPORT_ENABLED=true` habilita la API y el panel operativo, sin iniciar un worker en Render. `PUBLIC_BASE_URL` debe coincidir con el origen real: `https://asistobot.com.ar`. Se mantiene el inicio de sesión existente de Asisto.

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

La API de revisión permanece en `/api/support`. `/status` informa el agente de la PC del usuario, no un worker global. HubSpot sigue bloqueado por defecto.

## Compilación, pruebas y despliegue

`scripts/build_support_desktop.ps1` produce `static/downloads/AsistoSupport-5.00.062.zip` desde una lista explícita, sin `.env`, perfiles, claves ni `node_modules`. El instalador ejecuta `npm ci --omit=dev --ignore-scripts` con su lockfile.

Ejecutar `npm test`, `npm run support:migrate` y desplegar la web normalmente. La migración es aditiva y repetible; incorpora índices de dispositivos con expiración y unicidad por usuario. Los tests usan MongoDB efímero.

Se prueban emparejamiento/CSRF, usuarios simultáneos, reemplazo/revocación, recuperación de lease, aislamiento de mensajes/trabajos, DPAPI en Windows y los flujos previos. Las dependencias del instalador no reportaron vulnerabilidades en la validación. La vinculación y reconexión reales con WhatsApp requieren el teléfono del usuario.

Rollback: desactivar `SUPPORT_ENABLED`, revocar la PC o deshabilitar su inicio de Windows. Conservar perfiles y colecciones cifradas hasta decidir su retención. No se modifican colecciones legacy ni se publican datos en HubSpot.

La bandeja muestra por defecto borradores para revisar. El selector Mostrar permite consultar los descartados y todas las conversaciones, con contacto y fecha. Un descarte anterior explica el cambio de criterio y permite consultar los mensajes de origen, incluso para registros anteriores; no abre un formulario vacío. La evidencia tardía actualiza campos generados automáticamente sólo si no hubo intervención humana.

Ejemplo de referencia: un cliente pide un totalizador de gastos por cuenta y período y recibe orientación sobre sumas y saldos e interfaz contable. Se documenta como Soporte Remoto / Consulta / Capacitacion, En Proceso. La promesa de enviar un video no acredita envío ni cierre resuelto.

Las pausas de inactividad sólo controlan cuándo procesar. La agrupación reúne solicitudes, respuestas y confirmaciones tardías; una nueva solicitud explícita de otro tema inicia otro grupo. Los fragmentos generados se consolidan sin borrarlos (estado merged y vínculo al borrador principal). Si hay varias ediciones humanas incompatibles, se conserva todo y se exige reconciliación. Los contactos se sincronizan desde la agenda/nombre de perfil de WhatsApp por usuario, con alias LID/PN, sin usar el nombre propio de mensajes salientes. Se rellenan contactos vacíos; los nombres manuales existentes se conservan.
