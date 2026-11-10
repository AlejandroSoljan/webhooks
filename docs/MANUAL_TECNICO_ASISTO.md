# Manual técnico de Asisto

## Piloto web de Expreso Alfa — 2026-11-05

En **Pruebas Bot**, seleccionar `NEA_PRUEBAS` (superadmin). Acceso directo: `/admin/bot-test?tenant=NEA_PRUEBAS`. Perfil independiente en `tenant_config` y `settings` (`behavior:NEA_PRUEBAS`), sin número ni documento en `tenant_channels`; WhatsApp, Telegram, auto-update y habilitar_bot desactivados. No se modificó el comportamiento ni configuración de NEA/NEA2. No conectar canales reales a este perfil.

Modo conversacional, modelo gpt-5.4, historial estándar del simulador; usa la clave conversacional ya configurada. Las pruebas consumen API y se registran como bot_test. No habilita acciones externas, QR, leads ni análisis de comprobantes. Datos institucionales tomados de https://www.expresoalfa.com.ar/ y sus páginas nuevo-inventario, segunda-mano y financiacion, verificados el 05/11/2026: instantánea del sitio, no navegación en vivo.

El piloto responde servicios y depósitos, recopila datos para cotización y explica la derivación a Logística/Administración/Compras. No consulta saldos, facturas ni seguimiento real; no confirma pagos, tarifas ni entrega. Las derivaciones son simuladas. Ajustar el comportamiento seleccionando exclusivamente NEA_PRUEBAS. Validado con preguntas de depósito, cotización y guía ficticia; comprobada respuesta real en el panel y ausencia de canales vinculados. Para activar WhatsApp se requiere una tarea explícita y validación aparte.

Desarrollo compartido: [incorporación](INCORPORACION_DESARROLLADORES.md), [arquitectura](ARQUITECTURA.md) y [estándares](ESTANDARES_DESARROLLO.md).

Infraestructura para colaboradores: [entorno aislado de pruebas y protección de main](ENTORNO_PRUEBAS.md). Código y datos separados de producción; acceso mediante túnel SSH y sin salida a Internet desde la aplicación.

## Instalación de Mecan desde el QR (5.00.313 / Android 1.0.1)

Modal opcional después de guardar el turno, recuperación mediante Google Play Install Referrer y traslado autorizado del mismo documento/número. Invitación limitada a MCN Android web mediante `MECAN_INSTALL_PROMPT_ENABLED`, apagada hasta verificar la distribución compatible. Contrato, operación, asociación de firma Play, despliegue en ambos motores y pruebas en [Instalación Mecan y conservación del turno](MECAN_INSTALACION_TURNO.md).

Actualización de agentes existentes 5.00.306: `Actualizar.cmd` modifica únicamente código del worker en su ruta actual, con respaldo y comprobación del perfil; no reinstala dependencias, no cambia la extensión ni inicia vinculación. Operación en [Tickets WhatsApp](whatsapp_support.md#agente-windows-500305--cortes-de-descarga).

Agente Windows 5.00.305: corrección local del error no manejado en descargas Baileys y recuperación de hijo huérfano al reiniciar el supervisor. Conserva perfil y cola. Operación y pruebas en [Tickets WhatsApp](whatsapp_support.md#agente-windows-500305--cortes-de-descarga).

## Análisis comercial en Estadísticas Turnero (5.00.303)

La misma pantalla y los filtros de dominio y fechas agregan **Productos y consultas**: total de consultas registradas, resultados disponibles, consultas sin disponibilidad/código y errores. La tabla por origen (cámara/escáner, código/SKU, enlace QR, foto y otros) desglosa esos mismos resultados, sin sumarlos nuevamente. Preguntas y solicitudes de información se muestran aparte. Los éxitos históricos anteriores al registro detallado se identifican por separado y participan sólo del ranking; no representan lectura/importación de documentos técnicos. La API product-stats agrega bySource y metrics.measuredSuccessful. Presenta conclusiones respaldadas por cantidades/porcentajes y acciones sugeridas: exhibición/surtido, aclaraciones de precio, alternativas, compatibilidad y fricción por falta de resultado o errores. Conserva el diseño azul/verde, los indicadores operativos, los vendedores y el CSV de recorridos (no agrega datos comerciales a ese CSV). Si no hay actividad, ofrece ampliar el período a siete días mediante los mismos filtros; no cambia automáticamente el período.

Fuentes y límites:

- Fichas históricas: eventos `catalog.qr_read`/`catalog.code_lookup` de `monetization_events`, por `occurredAt`, cantidad y `metadata.code`. Este histórico depende de la medición comercial que estuviera habilitada; no demuestra que se hayan registrado todas las visitas.
- Desde la publicación, `/api/ext/qr/product` registra resultados `available`, `unavailable` y `error` en `qr_product_events` con tenant, código/SKU/descripción acotados, fecha de inicio y origen (`scan`, `sku`, `photo`, `qr`, `other`). La cámara etiqueta el origen `scan`; incluye reconsultas y recargas, no son personas ni escaneos físicos únicos. El registro usa hash de tenant/eventId para idempotencia, sin tokens ni eventos facturables, sin IP, identificador de sesión, contactos, imágenes, precios ni textos de preguntas. No bloquea la ficha si falla. Índice tenant/kind/at; sin purga automática añadida.
- La fecha del primer evento nuevo de cada tenant separa fuentes: monetización sólo antes, eventos analíticos después. Evita sumar dos veces la misma actividad. Un fallo de telemetría puede dejar registros incompletos; no se reconstruyen intentos inexistentes del histórico. Cámara/disponibilidad/errores no se infieren retrospectivamente. Se distingue falta de medición de actividad cero.
- Preguntas: sólo mensajes `role=user`, `meta.from=qr_web`; `meta.initial=true` cuenta como apertura de más información, no pregunta escrita. Usa `ts` y, si falta, `createdAt`. Clasifica con reglas (alternativas, precio/stock, compatibilidad, uso/técnica u otras), sin modelo ni lectura de conversaciones en el navegador. Clasificación orientativa, no análisis semántico exhaustivo.
- Ranking: une código de barras/SKU con el catálogo del mismo tenant; no resuelve arbitrariamente alias ambiguos. Examina los cien códigos de más actividad de cada fuente y hasta dos mil alias de catálogo; cantidades totales usan todos los registros. Se rotula ese límite. No implica ventas, conversión, compradores únicos, satisfacción, atención resuelta ni correlación con un vendedor o sucursal. El dominio completo es la unidad de análisis. Con pocos registros las conclusiones son orientativas.

Contrato y seguridad:

- GET `/api/customer-app-admin/:tenant/product-stats?from=AAAA-MM-DD&to=AAAA-MM-DD`: requiere el permiso de estadísticas/operación del dominio según los controles existentes, incluso si el turnero de demostración es público. En Mecan conserva el acceso de red interna permitido: únicamente nodo con `QUEUE_LOCAL_NETWORK_ACCESS=1`, tenant abierto y dirección privada. Sólo acepta X-Real-IP desde el proxy loopback, que lo sobrescribe con la IP real; no confía en encabezados enviados directamente desde Internet. Afuera requiere sesión. Rango máximo de 93 días, días inclusivos de Argentina; respuesta agregada y `Cache-Control: no-store`. No incluye textos, teléfonos ni identificadores de conversaciones.
- Mecan no tiene las consultas comerciales en su base local. Su servidor solicita el resumen central por `QUEUE_SYNC_URL`, con la clave existente `x-queue-sync-key`, cuerpo `{mode:product_stats,tenantId,from,to}`. No llega ningún secreto al navegador. `/api/ext/queue-sync` valida la clave y tenant autorizados antes del nuevo modo; éste termina antes de procesar colas y nunca cambia turnos. No se modifica la sincronización normal ni nginx. El resumen central consulta Cluster0; no sustituirlo por una copia local vacía.
- Si falla el servicio central, el bloque informa indisponibilidad en español, no inventa ceros ni retiene resultados de otro filtro. Las otras estadísticas cargan independientemente. Timeout local de diez segundos, cliente catorce; cancelación y secuencia evitan respuestas tardías de un período anterior. No genera llamadas de IA.
- Despliegue dedicado: `patch-product-insights.cjs` agrega sólo los puntos de montaje/lectura y envuelve la página instalada. Conserva los cambios locales de vencimiento, reapertura y estadísticas operativas; no reemplazar archivos de cola con versiones de main sin compararlos. Validar AWS y Mecan, permisos, filtros, estados vacíos/errores y ausencia de PII antes de dar por terminado.

Backend 5.00.301: MCN reactiva Consulta_sql 195 por decisión del negocio, sólo con stock. Una respuesta vacía muestra “Producto sin stock o no disponible” sin precio ni error técnico; la API no distingue inexistencia de falta de stock. Se conserva LP1, caché por origen, lectores y accesos. Contrato en [Catálogo SQL MCN](mcn_catalog_sql.md).

Backend 5.00.300: MCN migra consultas de producto a Manager `Api_Consultas_Generales/Consulta_sql`, consulta 195. Contrato y operación en [Catálogo SQL MCN](mcn_catalog_sql.md). Conserva lista de precios configurada y lector local sin IA.

Extensión 1.0.60 / backend 5.00.299: contactos asociados a la empresa bajo sus datos desplegables, consulta diferida y paginada con credencial del tenant. Contrato en [Tickets WhatsApp](whatsapp_support.md).

Extensión 1.0.58 / backend 5.00.298: listado de destinatarios corporativos Manager desde HubSpot con entrada manual y contexto de empresa, contacto y fecha de conversación en los correos nuevos. Contrato y límites en [Tickets WhatsApp](whatsapp_support.md).

### Correo de tareas por usuario — v5.00.297 / extensión 1.0.56

Configuración SMTP cifrada por usuario desde extensión, prueba de autenticación y envío de texto con revisión/confirmación explícita. Credenciales nunca se devuelven ni almacenan en Chrome. TLS obligatorio, destino público fijado tras DNS, auditoría cifrada por tarea e idempotencia conservadora ante timeout; no cambia ni guarda ticket automáticamente. Contrato, límites y operación en [Tickets WhatsApp](whatsapp_support.md#correo-smtp-por-usuario--500297--extensión-1056).

### Empresa asociada en extensión — v5.00.296 / 1.0.54

Ficha HubSpot por asociación del contacto o selección de empresa: tipo de cliente exacto (No Abonado en rojo), código, dirección/localidad y teléfonos. Lectura sin IA ni escrituras CRM, errores independientes del editor, caché acotada por dueño y descarte de respuestas obsoletas. Contrato y pruebas en [Tickets WhatsApp](whatsapp_support.md#ficha-de-empresa-en-extensión-1054-500296).

### Selector de dominio del Asistente IA — v5.00.291

`/comportamiento` muestra un selector ordenado por identificador de `tenant_config` para superadmin; los demás roles conservan su dominio fijo. Cambiar la selección carga una página nueva con `?tenant=...`, evitando guardar los datos del dominio anterior en el nuevo. Si hubo edición, solicita confirmación antes de descartarla. El diseño conserva las funciones y permisos existentes, incluida la advertencia de configuración global de MANAGER. Pruebas: `tests/behavior_ui_helpers.test.js` y `tests/behavior_pause_config.test.js`.

### Pantallas visibles de superadmin — v5.00.290

Para superadmin, `allowedPages` selecciona las opciones visibles del menú y accesos de Inicio; no restringe permisos ni rutas directas. Sin el campo se conserva el menú completo; una lista vacía deja Inicio. El acceso WhatsApp Web también aparece con soporte habilitado. Puede autoeditar pantallas y página inicial desde `/admin/users`, aunque oculte Usuarios: la ruta directa continúa habilitada. El servidor no acepta cambios propios de rol, dominio ni bloqueo en esa operación. Para admin/user se conservan las restricciones de acceso anteriores. Las casillas existentes de superadmins comienzan a controlar la navegación; no se migran documentos.

### Roles de usuarios — v5.00.289

Alta y edición presentan opciones de rol visibles (radios), sin desplegable nativo. Se envía el mismo campo `role`; superadmin puede elegir los tres roles y admin sólo user/admin. Continúan las restricciones de dominio y autoedición. Pruebas de alta con base simulada verifican persistencia, hash de contraseña, duplicados, validaciones y prohibición de elevar a superadmin. No generan cuentas en AWS.

### Administración de usuarios — corrección v5.00.288

Los modales de alta/edición se montan directamente en el cuerpo del documento, por encima de encabezado y navegación. Al abrirlos se cierra el menú móvil y se enfoca el primer campo. Cerrar, Cancelar, fondo y Escape conservan su comportamiento; no se cambian validaciones, credenciales ni permisos. Verificación: `node --test tests/users_modal.test.js tests/admin_navigation.test.js`. La corrección corresponde al panel central AWS, no al servicio local exclusivo del turnero.

Edición 1 — 02/10/2026. Base de código documentada: `00c5ea7`. Destinatarios: instalación, soporte, configuración de clientes e integradores. Documentación de operación, no autorización para intervenir un cliente.

## Índice

Política de costo proveedor v5.00.283: los reportes de consumos recalculan cada evento histórico por su modelo registrado antes de sumar dominios o conversaciones. Las tarifas manuales `token_cost_*` no reemplazan al costo del modelo. Un `costUsd` numérico registrado tiene prioridad; para audio no se agrega además un costo por tokens. Sin importe registrado se estima por modelo y tokens, o duración de audio. Modelos sin tarifa/datos se señalan mediante `unpriced_events` y como incompletos; el subtotal no los incluye. Las tarifas estándar calculadas son estimaciones, no una conciliación de factura (pueden faltar caché, descuentos o tarifas históricas). Se mantiene el margen comercial y las tarifas de venta explícitas; no se modifican comprobantes emitidos ni eventos originales. El recálculo histórico ocurre al consultar el período. Prueba de regresión DEMJG: costo estimado 0,205929 USD, con margen 100 % 0,411858 USD para el corte auditado.

Actualización SDG (2026-10-04): imágenes y PDF habilitados por `transfer_receipt_analysis_enabled` se leen como documentos generales (pedidos, productos, facturas, capturas o transferencias). Se conserva la leyenda del cliente y los datos extraídos para que el motor conversacional aplique el comportamiento y el historial. No se usa el acuse fijo de transferencia para SDG; sólo se pregunta por información imprescindible o intención ambigua, sin afirmar pagos acreditados ni acciones no realizadas. La lectura usa por defecto hasta 1800 tokens de salida, respetando un límite configurado. Los otros dominios y la identificación de productos no cambian. Se mantiene el evento de consumo existente `ai.transfer_receipt_analysis` por compatibilidad; su nombre histórico no implica que todo archivo sea una transferencia. Pruebas: `tests/media_interpretation.test.js` y `tests/transfer_receipt.test.js`.

1. [Arquitectura y ubicaciones](#1-arquitectura-y-ubicaciones)
2. [Instalación y publicación](#2-instalación-y-publicación)
3. [Alta de un cliente](#3-alta-de-un-cliente)
4. [Usuarios y permisos](#4-usuarios-y-permisos)
5. [WhatsApp y mensajes por API](#5-whatsapp-y-mensajes-por-api)
6. [IA, pedidos y atención](#6-ia-pedidos-y-atención)
7. [Ayuda de Manager](#7-ayuda-de-manager)
8. [Productos, QR y catálogo](#8-productos-qr-y-catálogo)
9. [Turnero y pantallas](#9-turnero-y-pantallas)
10. [Restaurante](#10-restaurante)
11. [Tareas, PC y HubSpot](#11-tareas-pc-y-hubspot)
12. [Otros módulos](#12-otros-módulos)
13. [Consumos y facturación](#13-consumos-y-facturación)
14. [APIs y ejemplos](#14-apis-y-ejemplos)
15. [Variables y datos](#15-variables-y-datos)
16. [Diagnóstico y recuperación](#16-diagnóstico-y-recuperación)
17. [Mantenimiento del manual](#17-mantenimiento-del-manual)

Anexos buscables: [rutas HTTP](manual-tecnico/rutas.md), [variables de entorno](manual-tecnico/entorno.md), [variables de dominio](manual-tecnico/variables-dominio.md), [colecciones](manual-tecnico/colecciones.md).

## 1. Arquitectura y ubicaciones

Asisto es una aplicación multiempresa. `tenantId` identifica el dominio lógico de un cliente; no es necesariamente un nombre DNS. La aplicación web, los agentes WhatsApp, el turnero local y los servicios externos son componentes distintos y pueden tener versiones diferentes.

| Componente | Función | Referencia |
|---|---|---|
| Backend Node/Express | Web, autenticación, APIs, lógica y registros | `server.js`, `endpoint.js` |
| MongoDB productivo | Configuración, conversaciones, consumos y operación | AWS Lightsail, base `Cluster0` |
| Runtime por dominio/canal | Resuelve configuración y mantiene caché | `tenant_runtime.js` |
| Agente WhatsApp Web | Conexión local y ejecución de envíos | `app_asisto_ws.js`; instalación puede provenir del repo separado `asisto_ws_web` |
| Agente de tareas | Baileys por usuario de Windows | `desktop/support` |
| Turnero | Reservas, emisión, atención y pantallas | `customer_queue.js`, servicio separado en AWS/local según instalación |
| Integraciones | Manager, Meta, Telegram, fuentes comerciales, HubSpot, IA | Configuración específica por función |

Verificación de infraestructura realizada por SSH: AWS `ip-172-26-0-152`, servicio `asisto-production`, ejecutable `/usr/local/bin/node -r dotenv/config /opt/asisto/current/server.js`, release `00c5ea78aa63-auto-vfjSxylI`, salud `{ "ok": true }`. Estos datos son una fotografía; verificar de nuevo antes de operar.

Producción usa `/etc/asisto/production.env`. `/opt/asisto/current` es un enlace al release activo. Releases anteriores permanecen en `/opt/asisto/releases`. El estado escribible se aloja en `/var/lib/asisto`. No usar el `.env` de una PC ni una copia Atlas como fuente de producción.

Las referencias antiguas a Render en documentos enlazados son históricas. En la instalación actual, trasladar la gestión de variables y logs al servicio AWS. No ejecutar instrucciones antiguas de Render como si describieran el despliegue vigente.

## 2. Instalación y publicación

### Entorno de desarrollo o pruebas

Requisitos: Git, Node 24.x y una base MongoDB de pruebas independiente. Instalar dependencias con el lockfile:

```powershell
git clone https://github.com/AlejandroSoljan/webhooks.git
cd webhooks
npm ci
```

Configurar el entorno de pruebas mediante el mecanismo seguro del equipo. No copiar el archivo productivo a la instalación de un cliente. Variables mínimas del proceso: `MONGODB_URI`, `MONGODB_DBNAME` si el URI no trae base, `PORT`, secretos de autenticación y las claves exclusivas de las funciones habilitadas. `server.js` arranca el servidor y el runtime Telegram; revisar `ENABLE_TELEGRAM` para no iniciar integraciones reales en pruebas.

```powershell
node server.js
```

Probar `/healthz`, login y una operación del módulo elegido. Salud HTTP no prueba WhatsApp, Mongo, IA ni entrega de mensajes. `npm test` ejecuta la batería; las pruebas que usan MongoMemoryServer requieren poder descargar/ejecutar su binario. No apuntar pruebas manuales a clientes reales por comodidad.

### AWS actual

Control de consumos 5.00.314: resumen inicial de ventanas con `details=0` no recorre el historial manual/real de WhatsApp. Ese recuento sigue disponible al abrir el detalle (`details=1`, sólo superadmin). El gráfico carga de forma independiente; si falla no oculta el resumen completo. Las consultas del navegador tienen 45 segundos de límite y el detalle real Mongo 60 segundos; errores dejan el total a cobrar como **Pendiente / reporte incompleto**, nunca como cero válido. No cambian tarifas, importes históricos ni el método de cobro por ventanas. Verificación: pruebas `token_control_lazy`, `token_control_api_messages`, `token_control_window_prices`, `token_control_groups` y reporte autenticado en AWS.

Dominio adicional `asisto.com.ar` y `www.asisto.com.ar`: configuración HTTPS, certificado, renovación y recuperación documentados en [deploy/asisto-domain/README.md](../deploy/asisto-domain/README.md). Se conserva `asistobot.com.ar` sin redirección forzada ni cambios a integraciones existentes.

El alias SSH `asisto-aws` usa el acceso configurado en la PC. En esta instalación incluye un túnel loopback `127.0.0.1:37017` hacia MongoDB del servidor; conservarlo privado. No cambiar rutas de red ni la conexión del servidor de Mecan para publicar el backend.

```powershell
ssh asisto-aws 'hostname; readlink -f /opt/asisto/current; systemctl is-active asisto-production; curl -fsS http://127.0.0.1:3000/healthz'
ssh asisto-aws 'sudo journalctl -u asisto-auto-deploy.service -n 30 --no-pager'
```

El mecanismo `/usr/local/sbin/asisto-auto-deploy` consulta `main` mediante un timer, crea un release, instala dependencias, ejecuta pruebas y cambia el enlace sólo al aprobar. Reinicia `asisto-production` y comprueba `/healthz`; ante fallo de salud vuelve al release anterior. Un commit rechazado queda registrado para evitar reintentos continuos. No borrar esa marca sin diagnosticar la causa.

Secuencia de entrega: registrar cambios en `HISTORIAL_CAMBIOS_BACKEND.txt` cuando corresponda, ejecutar validación, publicar código, esperar el despliegue y verificar release, salud y pantalla/endpoint afectado. GitHub actualizado no significa servidor actualizado.

Para una reversión manual, el operador debe identificar el release anterior válido, confirmar compatibilidad de datos, cambiar el enlace de forma atómica y reiniciar sólo el servicio afectado. Coordinar primero el autodespliegue para evitar que vuelva a instalar la revisión retirada. No borrar releases ni datos durante un diagnóstico.

Los cambios que afecten MCN deben verificarse en AWS y en el servidor local Mecan conforme a `AGENTS.md`. Una actualización de web no actualiza automáticamente todos los agentes de escritorio ni los APK.

## 3. Alta de un cliente

1. Registrar identificador estable del dominio, razón social, teléfono internacional, módulos contratados, usuarios responsables y dominio titular del cobro.
2. En Configuración del negocio → Dominio, crear/configurar el registro del cliente. No copiar tokens, teléfonos ni integraciones de otro cliente.
3. Crear usuarios y asignar permisos por pantalla. Probar con una sesión del operador, no sólo con superadmin.
4. Configurar Canales: transporte elegido, teléfono y credencial específica. Para Meta, comprobar `phoneNumberId`; para WhatsApp Web, preparar el agente y vincular el teléfono.
5. En Asistente IA definir modo, instrucciones, modelo y fuentes. Cargar Horarios y Reglas de pedidos si aplican.
6. Habilitar únicamente las funciones requeridas; definir catálogo, puestos, mesas u otras entidades del módulo.
7. Configurar Monetización: moneda, tarifa, créditos y activación. Revisar el total previsto antes de habilitar facturación.
8. Realizar prueba con un destinatario autorizado: entrada, respuesta, reintento, registro, permisos y clasificación del consumo.
9. Entregar URLs, procedimiento de inicio, responsable y prueba de aceptación. Registrar versiones web/PC por separado.

### Dominios secundarios

`tenant_config.consumption_domains` consolida cobros bajo el titular. Ejemplo de estructura, no comando de escritura:

```json
{ "_id": "CLIENTE", "consumption_domains": ["CLIENTE2"] }
```

El titular incluye sus propios consumos y los secundarios. El informe conserva el origen. NEA/NEA2 y MSM/ALSO/DEMJG son ejemplos de agrupación usados en la operación. No confundir esta relación con permisos de usuarios, aliases del ERP ni canales de WhatsApp: configurar cada relación según su función. Evitar que un secundario pertenezca a dos titulares o formar ciclos. Cambiar la relación afecta cómo se presenta el histórico consultado; no crea una factura cerrada.

## 4. Usuarios y permisos

El acceso web usa la autenticación de Asisto y `allowedPages`. Superadmin puede seleccionar dominios en las pantallas que lo soportan; usuarios normales quedan limitados a su alcance. Ocultar un menú no sustituye la validación del backend.

Permisos relevantes: `tenant_config`, `canales`, `comportamiento`, `horarios`, `order_config`, `client_access`, `wweb`, `support`, `productos`, `resto`, `queue_kiosk`, `queue_attention`, `queue_display`, `queue_stats`, `token_control`, `monetization`. Consultar `auth_ui.js` y `admin_navigation.js` para el catálogo completo.

Probar acceso autorizado y rechazo desde otra cuenta. No compartir la cookie de superadmin ni usarla dentro de un agente. Las métricas de mensajes manuales/recibidos tienen restricciones de rol; conservarlas al crear nuevos reportes.

## 5. WhatsApp y mensajes por API

### Elegir transporte

Meta Cloud API recibe la validación GET y los eventos POST en `/webhook`; el runtime identifica el canal por `phone_number_id`. WhatsApp Web depende del proceso conectado al teléfono. No son intercambiables por cambiar únicamente una URL.

Para la instalación de WhatsApp Web, comprobar primero el directorio real y `git remote -v`. Una PC puede usar `C:\asisto` con el repo `asisto_ws_web`; no asumir que existe una subcarpeta `whatsapp-agent`. Conservar perfiles, autenticación y modificaciones locales. `release_tag` fija la versión pretendida del agente; verificar la versión reportada después de actualizar.

La API de control tiene base `/api/ext/wweb/agent`. El cliente usa `control_api_url` y `control_api_token`/mecanismo de autenticación configurado. `bootstrap`, `ping`, `db` y `operator-message` son operaciones del protocolo del agente, no endpoints genéricos para aplicaciones de terceros. No cambiar el backend del agente a una copia Mongo local para resolver una desconexión.

### Variables operativas

| Campo | Uso |
|---|---|
| `habilitar_bot` | Procesamiento de entradas |
| `habilitar_consulta_mensajes` | Consulta/envío de pendientes |
| `habilitar_odbc_manager`, `dsn` | Integración local ODBC de Manager |
| `api`, `api2`, `api3` | Procesamiento, consulta de pendientes y actualización de estado |
| `key` | Credencial de esas integraciones; guardar como secreto |
| `api_mensajes_alta` | Registro externo de nuevos mensajes |
| `api_mensajes_confirmacion_habilitada` | Solicitud de permiso antes del envío automático |
| `api_mensajes_confirmacion_respuestas_ok` | Respuestas reconocidas como autorización |
| `api_mensajes_respuestas_baja` | Solicitudes de exclusión |
| `api_mensajes_limite_diario` | Límite automático; 0 según ayuda significa sin límite |
| `consulta_mensajes_respetar_horarios` | Aplicación de horarios a pendientes |
| `heartbeat_ms`, `lease_ms` | Frecuencia de actividad y exclusividad de ejecución |

El anexo de variables incluye tiempos, prioridades, límites y protección frente a fallos. Respetar unidades: `*_ms` son milisegundos, ventanas usan minutos; no convertir por intuición.

### Estados y diagnóstico

Un mensaje encolado no equivale a enviado, entregado ni leído. `OK` del cliente es autorización funcional y no el acuse técnico de WhatsApp. `sin_respuesta_timeout` exige revisar solicitud, respuesta y fechas del mismo intento; una respuesta histórica no acredita aceptación del intento actual.

No ejecutar `Consulta_no_enviados` como prueba de conectividad: puede reservar o cambiar pendientes. Consultar primero estado y registros. Los mensajes manuales, enviados por Asisto y sin origen identificable deben permanecer separados; no clasificar por mera dirección saliente.

## 6. IA, pedidos y atención

Corrección 5.00.278: el cargador conserva `operator_pause_minutes` y `conversation_inactivity_minutes` del comportamiento por empresa. Un mensaje manual crea la conversación si todavía no existe, registra el mensaje y aplica la pausa configurada. El gateway vuelve a comprobar la pausa después de generar respuestas. El agente 4.05.18 consulta `PauseOnly` antes de entregar documentos de Manager y reconoce `action=paused`.

La clasificación de Manager ofrece herramientas de lectura: modificar un pedido debe continuar al asistente y sus acciones externas según el comportamiento. `ToolResult` permite devolver el resultado ODBC a la IA para redactar `replyText` en contexto; no otorga capacidades de escritura. Los cambios de productos requieren una acción configurada o atención humana. Las reglas comerciales de cada empresa siguen en su comportamiento.

El asistente combina configuración de dominio, canal, fuentes y reglas. Configurar Comportamiento, Horarios, Productos y Reglas de pedidos según el módulo; validar consultas fuera de horario, información inexistente y traspaso a atención manual.

Las claves seleccionadas por `ai_key_router.js` son independientes:

| Función | Variable del servidor |
|---|---|
| Pedidos | `OPENAI_API_KEY_PEDIDOS` |
| Conversacional, QR | `OPENAI_API_KEY_CONVERSACIONAL` |
| Ayuda | `OPENAI_API_KEY_AYUDA` |
| Tareas WhatsApp | `OPENAI_API_KEY_TAREAS_WS` |

El router exige la clave de su función; no suponer reemplazo por `OPENAI_API_KEY` global. El modelo se configura por función; comprobar compatibilidad del proveedor y consumo registrado antes de migrarlo. Nombres de modelos y precios en documentos antiguos no son garantía de disponibilidad actual.

Bandeja `/admin/inbox`: seguimiento de conversaciones y atención manual. `/comportamiento` configura reglas; `/horarios` disponibilidad; `/productos` catálogo. Las operaciones `/api/admin/send-message` y cambios de estado sí modifican datos y pueden enviar mensajes. Validarlas en un caso controlado.

## 7. Ayuda de Manager

`GET/POST /api/ext/ayuda` y `/api/ext/help`. Autenticación recomendada `X-API-Key`; revisar la clave habilitada en el servidor. Campos: `dominio`, `usuario`, `version`; además `consulta` para pregunta inteligente o `ventana` para ayuda contextual. `agente` usa MANAGER por defecto según el contrato documentado.

La respuesta incluye `respuesta`, `fecha` y `vimeo_ids`. En modo contextual `respuesta` es `S` o `N`; en inteligente contiene texto. `vimeo_ids` es un array de objetos, no de números sueltos. Una lista vacía es válida.

Contrato detallado y errores: [Ayuda](api/MANUAL_API_AYUDA.md), [modo contextual](api/MANUAL_API_AYUDA_SIN_CONSULTA.md). La disponibilidad real de las fuentes debe probarse con la versión y ventana del cliente.

## 8. Productos, QR y catálogo

Lectura local de códigos (2026-10-16): Android conserva `BarcodeDetector` cuando está disponible; iPhone y otros navegadores usan ZXing 0.21.3 en el dispositivo, preferentemente en un Web Worker. Si el lector nativo no encuentra el código durante cinco segundos, el respaldo también es local. Se exigen dos detecciones coincidentes antes de consultar el precio. No se envían capturas automáticas a `/api/ext/qr/photo`; esa ruta se conserva exclusivamente para la opción explícita de fotografiar un producto. El límite de reconocimiento por IA ya no afecta el escaneo de barras. Los assets versionados se sirven desde `/api/ext/qr/scanner-assets/`, sin CDN en ejecución. En la intranet HTTP de Mecan, `/qr/:tenant` abre el scanner público HTTPS, necesario para acceder a la cámara; no cambia las rutas ni permisos de operadores, tótems y displays. Ver [lector local](qr_local_scanner.md).

Ruta pública `/qr/:tenant?codigo=SKU`, también `/qr/:tenant/:codigo`. API de producto `/api/ext/qr/product`; chat y consulta de historial según [manual QR](api/MANUAL_API_QR.md). Mantener `sessionId` estable y códigos como texto para preservar ceros iniciales.

Configurar fuente comercial, autenticación, mapeo de código/precio/stock e identidad del comercio. Los precios y disponibilidad provienen del catálogo/API del comercio, no de inferencias de IA. Probar SKU existente, inexistente y barras duplicadas.

`qr_product_catalog` mantiene espejo por tenant y origen. Revisar [catálogo](product_catalog.md), `product_catalog.js` y `product_catalog_sync.js` para vigencia y renovación. Importación inicial: validar un archivo con `scripts/import_product_catalog.js`; la opción `--apply` escribe. Confirmar fecha de observación, dominio y origen antes de aplicar. No reemplazar precios actuales con una exportación antigua.

## 9. Turnero y pantallas

| Pantalla | URL |
|---|---|
| Emisión | `/customer-app/DOMINIO/kiosk` |
| Operadores | `/ui/turnero/DOMINIO` |
| Televisores | `/customer-app/DOMINIO/display` |
| Estadísticas | `/ui/turnero/DOMINIO/estadisticas` |
| Celular | `/customer-app/DOMINIO?view=turns` |

Configurar secciones, vendedores/puestos y acceso; verificar servicio escritor para evitar dos motores operando la misma cola. Kiosco, operador y display son pantallas diferentes. El modo claro/oscuro del operador no implica modificar el kiosco.

`queue_counter_reset_daily=true` reinicia numeración diaria; `false` continúa. No modificar contadores directamente para reiniciar una prueba. La reserva QR se activa al reclamar o imprimir; vencimientos y reintentos deben conservar identidad y no duplicar turnos. Traslado, finalización y ausente son acciones operativas distintas.

Validar emisión → reclamación/impresión → espera → llamado → finalización. Probar audio de televisión, pantalla completa y resolución real. El navegador puede requerir gesto para habilitar sonido. Probar impresora física, falta de papel y reimpresión del mismo ticket. Verificar que el QR use un origen accesible desde el celular.

Para app/notificaciones, comprobar dispositivo, permisos y entrega real; un token registrado no prueba recepción. Consultar [Identidad de destinatarios y duplicados](NOTIFICACIONES_DISPOSITIVOS.md) para agrupación, envíos únicos y sus límites. [Historia operativa del turnero](turnero_aws.md) contiene referencias de releases anteriores; consultar `customer_queue.js` y sus módulos importados para las reglas actuales.

## 10. Restaurante

Habilitar `restaurant_enabled`, crear productos con precios, ingredientes e imágenes, mesas y usuarios `resto`. Operación `/ui/resto`; carta `/resto/DOMINIO/TOKEN_MESA`. Superadmin puede elegir dominio; operador normal trabaja en su ámbito.

Variables de uso frecuente: `restaurant_orders_enabled`, `restaurant_guest_ai_enabled`, `restaurant_call_waiter_enabled`, `restaurant_request_bill_enabled`, `restaurant_order_confirmation_required`, `restaurant_guest_auto_approval`, `restaurant_visit_hours`, `restaurant_manual_payments_enabled`, `restaurant_ai_model`. Tipos/defaults validados en `restaurant_config.js` y anexo.

Flujo: abrir mesa, habilitar celular, recibir pedido, confirmar para cocina cuando se exige, atender, registrar pago y cerrar. Cerrar revoca la visita. Un QR existente no autoriza reabrir una visita vencida. Probar un segundo celular y un acceso después del cierre.

El botón Mercado Pago del restaurante está descrito por el propio configurador como informativo. Registrar un pago manual no es verificar un cobro electrónico. [Guía específica](restaurante.md).

## 11. Tareas, PC y HubSpot

El agente personal ejecuta Baileys en la PC de cada usuario; el backend recibe mensajes y procesa el trabajo del propietario. La extensión es una interfaz de WhatsApp Web y revisión. No instalar un worker compartido para reemplazar este diseño.

Instalar el paquete vigente generado desde `desktop/support`; autorizar desde Sesiones WhatsApp Web con usuario `support`; cargar/recargar la extensión según instrucciones del instalador; escanear QR; probar reconexión tras reiniciar Windows. No fijar en este manual el nombre de un ZIP antiguo como última versión.

Variables principales: `SUPPORT_ENABLED`, `PUBLIC_BASE_URL`, `AUTH_COOKIE_SECRET`, claves de tareas y, si corresponde, `SUPPORT_HUBSPOT_ENABLED` y credencial HubSpot por tenant. El origen debe coincidir exactamente con el autorizado por extensión y puente local.

El backend cifra contenidos; Windows protege credenciales del agente por perfil. Rotar secretos sin conservar capacidad de descifrado puede volver ilegible el histórico. Revisar la estrategia de claves de `src/support/config.js`/`crypto.js` antes de rotarlas.

Probar importación, nombre de contacto, selección de mensajes, borrador, edición humana, publicación y reintento sin duplicado. HubSpot exige permisos, cuenta y propiedades compatibles. Un borrador local no es un ticket publicado. Detalles e instalación: [tareas WhatsApp](whatsapp_support.md); APIs actuales: [índice](manual-tecnico/rutas.md).

## 12. Otros módulos

| Función | Configuración y validación | Fuente |
|---|---|---|
| Telegram | Token/usuario del bot, ENABLE_TELEGRAM, comprobar arranque y respuesta del dominio | `telegram_runtime.js`, `tenant_runtime.js` |
| Leads | Formulario público, captura habilitada, origen y aviso; queued sólo significa encolado | `lead_notification.js`, [avisos](lead_notification.md) |
| Seguimiento | Conversaciones, clasificación y revisión de estado; revisar efecto de reclasificar con IA | `conversation_followup_panel.js` |
| Fleteros | Configuración del cliente, viajes y acciones según panel; validar viaje de prueba y alcance | `fleteros_viajes_panel.js` |
| Notificaciones app | Dispositivos y avisos del dominio; comprobar permisos y entrega | `customer_notifications.js` |
| Acceso web | Auditoría de sesiones/visitas y permisos | `web_access_stats.js` |

Para módulos sin contrato externo publicado, usar las pantallas existentes y el handler del catálogo antes de automatizar. No deducir parámetros de una URL solamente.

## 13. Consumos y facturación

### Audios e imágenes del detalle de WhatsApp

El detalle de envíos reales permite a superadmin solicitar notas de voz (`ptt`/`audio`) e imágenes (`image`). Botones “Escuchar audio” y “Ver imagen”: recuperan el archivo bajo demanda desde la sesión; las imágenes se amplían en una pestaña privada y los audios ofrecen controles de reproducción. No generan transcripciones ni consumos de IA. Requiere agente WhatsApp **4.05.16 o posterior instalado**, no sólo publicado; los agentes anteriores muestran aviso de actualización.

APIs protegidas exclusivamente para superadmin: `POST /api/token-control/messages/:id/media` (header `X-Asisto-Media: 1`, ID Mongo del registro), `GET /api/token-control/media/:id` (estado) y `GET /api/token-control/media/:id/content` (binario con soporte Range). No admiten URLs ni rutas de archivos del navegador. La acción `read_message_media` se encola para el `lockId` exacto; verifica contacto y dirección. Excluye vista única, formatos activos y archivos mayores a 5 MiB. Mantiene la copia en `wa_wweb_actions.result` durante 15 minutos mediante `mediaExpiresAt` y TTL; el endpoint rechaza inmediatamente expirados aunque la limpieza de Mongo tarde. Usa `no-store`, validación de firma binaria/MIME y acceso privado también al abrir una imagen ampliada. Borrar el registro original revoca su acceso. Los registros históricos no contienen los binarios: si el agente/WhatsApp ya no dispone del mensaje, se informa archivo no disponible. No garantiza recuperar archivos antiguos ni archiva automáticamente todos los nuevos adjuntos. Despliegue del backend y actualización de agentes son pasos diferentes; verificar versión reportada antes de afirmar disponibilidad de recuperación.

Control de Consumos abre el mes en curso: día 1 a hoy. Si se selecciona un día, la evolución es horaria. El gráfico usa eventos por fecha real y agrupa tarifa por modelo; tokens, USD y mensajes tienen escalas independientes. Comparar valores del punto, no alturas entre series.

La tabla agrupa por titular, conserva detalle del dominio origen y suma al pie. El resumen superior y el pie suman importes en pesos redondeados por cliente a centavos. El desglose USD/ARS permanece visible.

Conversión actual: componente ARS + componente USD × cotización de la API de Estadísticas Cambiarias del BCRA. El panel muestra fuente y fecha. El servidor consulta al usar el reporte, mantiene caché de 30 minutos y conserva respaldo en `exchange_rates`; ante fallo puede informar último valor disponible. Esto no es una tasa congelada por factura ni una garantía de cotización vendedor BNA.

Con monetización habilitada, `aiMarkupPercent` aplica recargo al costo calculado: 100% implica costo × 2. Quitar “Margen IA” del panel no elimina esa configuración. Revisar `token_cost_*`, `token_charge_*` y `openai_model_pricing.js`: las tarifas configuradas pueden prevalecer sobre el fallback por modelo. El catálogo comercial incluye funciones previstas; existencia de un concepto no demuestra que cada flujo lo mida automáticamente.

API Mensajes se cobra usando los importes persistidos en `wa_api_message_windows`, también en períodos históricos. El reporte elimina la medición monetizable duplicada de `whatsapp.api_sent` cuando hay ventanas de ese dominio; la cantidad de mensajes es informativa, no multiplica la tarifa. Conserva las tarifas y monedas históricas de cada ventana y los otros conceptos.

Revisión del catálogo interno 2026-10-07: GPT-6 Astra Standard USD 10/50 y GPT-6 Luna USD 0,10/0,50 por millón de tokens entrada/salida (fuentes oficiales: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)). No confundir pestañas Batch/Flex con Standard. GPT-6 Sol queda pendiente de verificación; no se sustituyó por GPT-6.1 Sol. El dry-run de sincronización revisó 48 dominios sin asignaciones a los modelos corregidos, por lo que no se escribieron costos de dominios ni tarifas comerciales.

Los conceptos a cobrar se presentan en la misma fila que el dominio de origen de la segunda columna. Cada fila conserva servicios, cantidades e importes de IA, ventanas API y otros consumos, con subtotal propio por moneda, sin repetir un encabezado de dominio en la tercera columna. Titular, costo y total consolidado usan celdas compartidas (rowspan). El total consolidado del titular no cambia. Los créditos incluidos se conservan según el resumen monetizable de cada dominio; no se reconstruyen sumando importes brutos.

Desde agente 4.05.17, `api_mensajes_limite_unidad=clientes` interpreta `api_mensajes_limite_diario` como destinatarios distintos por número emisor y día argentino. Los repetidos no consumen nuevos cupos y pueden continuar al alcanzar el límite. Manuales y entradas quedan excluidos. Sin esa configuración se conserva el conteo por mensajes. Requiere verificar la versión efectiva del agente; cambiar Mongo no actualiza por sí solo una instalación bloqueada.

**Mercado Pago: primera etapa de preparación y pruebas disponible** en `/admin/billing`, sólo superadmin. Guarda configuración por titular y agrupa dominios asociados; incluye adhesión, consulta, cancelación y verificación de pagos exclusivamente con cuentas de prueba. No existen débitos productivos habilitados ni cierre de facturas. Consultar [manual de suscripciones](suscripciones-mercadopago.md) para APIs, variables, pruebas y pendientes. Antes de cobros reales deben completarse liquidación mensual inmutable, cotización congelada, consentimiento, conciliación de períodos y programación segura del importe variable. Nunca confiar en el total enviado por el navegador.

## 14. APIs y ejemplos

### Clasificación de acceso

Las rutas `/admin`, `/ui` y APIs de panel requieren sesión y permisos según handler. APIs `/api/ext` pueden exigir clave o credencial de agente; QR tiene rutas públicas con límites. No asumir una autenticación única para todos los prefijos. El [inventario](manual-tecnico/rutas.md) enlaza cada registro al código y señala sus límites de extracción.

### Ayuda desde PowerShell

Ejemplo que puede consumir IA; ejecutar sólo para un cliente de prueba. `$env:ASISTO_HELP_KEY` debe cargarse por el mecanismo seguro del técnico, no escribirse en el manual.

```powershell
$body = @{ dominio='CLIENTE_PRUEBA'; usuario='tecnico'; version='5.00'; consulta='¿Cómo consulto un artículo?' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'https://www.asistobot.com.ar/api/ext/ayuda' -Headers @{'X-API-Key'=$env:ASISTO_HELP_KEY} -ContentType 'application/json' -Body $body
```

### Consulta de producto

```http
GET /api/ext/qr/product?tenant=CLIENTE_PRUEBA&codigo=000123
```

Requiere configuración QR activa y artículo real del dominio. Puede consultar la API comercial y registrar consumo de la función; no usar como barrido masivo de disponibilidad.

### Control de consumos

| Método y ruta | Parámetros principales | Resultado |
|---|---|---|
| GET `/api/token-control/summary` | `tenantId`, `from`, `to`, `types`, `channels` | Resumen de IA y titulares |
| GET `/api/token-control/timeline` | Mismos filtros | Serie diaria/horaria |
| GET `/api/token-control/conversations` | Filtros y `limit` | Detalle de conversaciones |
| GET `/api/token-control/api-message-windows` | Filtros, `details=0` para resumen | Datos API Mensajes |
| GET `/api/token-control/exchange-rate` | Sin filtros | Cotización USD/ARS y vigencia |

Requieren autenticación web y permiso. `from` y `to`: `YYYY-MM-DD`. El dominio solicitado se restringe por usuario. Los totales consolidados en pesos del panel se calculan actualmente al combinar respuestas en frontend; estas rutas no constituyen todavía una API de facturas ni de pago.

### Manejo de errores y reintentos

Revisar HTTP y JSON: 400 datos inválidos, 401 autenticación, 403 permiso, 404 recurso/función, 409 conflicto, 429 límite y 5xx dependencia/servidor según cada contrato. No reintentar ciegamente POST de envío, cobro, traslado o publicación CRM después de un timeout: verificar si la operación quedó registrada. Conservar identificador de correlación, dominio, fecha y respuesta sin credenciales ni contenido privado innecesario.

## 15. Variables y datos

Tres niveles: entorno del servidor para secretos/infraestructura; `tenant_config` y configuración del módulo para negocio; configuración local del agente para su instalación. Cambiar una variable en un nivel no modifica automáticamente los demás.

| Variable | Uso y comprobación |
|---|---|
| `MONGODB_URI`, `MONGODB_DBNAME` | Conexión/base; el URI puede determinar la base. Verificar `db.databaseName` |
| `PORT` | Puerto de escucha de `server.js`; default de código 3000 |
| `PUBLIC_BASE_URL` | Origen público para enlaces/integraciones que lo usan |
| `AUTH_COOKIE_SECRET` | Secreto de sesión; también puede participar del cifrado de tareas |
| `ENABLE_TELEGRAM` | Arranque de runtime Telegram |
| `OPENAI_API_KEY_*` | Claves separadas por tipo de IA, sección 6 |
| `WWEB_CONTROL_API_URL`, `WWEB_CONTROL_API_TOKEN` | Configuración del agente HTTPS cuando ese cliente la admite |
| `LEAD_NOTIFY_WWEB_TENANT/FROM/TO` | Origen y destino del aviso de formulario |

Anexos completos: [entorno](manual-tecnico/entorno.md), [dominio](manual-tecnico/variables-dominio.md). El inventario de entorno no incluye valores ni lee `.env`; variables dinámicas se documentan en sus módulos. Reiniciar sólo el proceso que lee una variable de entorno cuando el cambio lo requiere. La configuración por tenant puede tener caché; utilizar el refresco del módulo o esperar su vencimiento antes de asumir un fallo.

Colecciones de referencia: `tenant_config`, `tenant_channels`, `conversations`, `ai_token_usage_log`, `wa_wweb_message_log`, `wa_api_message_windows`, `monetization_config`, `exchange_rates`, `qr_product_catalog`, `queue_tickets` y familias `support_*`/`restaurant_*`. Ver [referencias de colecciones](manual-tecnico/colecciones.md). No publicar volcados de producción como ejemplos. Copias y retención deben preservar relaciones y capacidad de descifrado.

## 16. Diagnóstico y recuperación

| Síntoma | Comprobar primero | Siguiente acción |
|---|---|---|
| Cambio no visible | Release activo y journal de auto-deploy | Resolver prueba/despliegue; después recargar pantalla |
| Agente sin actualizar | Repo/directorio real, release_tag, versión reportada | Revisar actualización local conservando perfil |
| WhatsApp desconectado | Heartbeat, lease, estado vinculado, red de PC | Reconectar sesión propia; no duplicar agentes |
| Mensaje no enviado | Cola, permiso OK, BAJA, horario, límites, fallo | Correlacionar el intento antes de reenviar |
| IA no responde | Clave exclusiva, modelo, cuota, fuente, error | Probar caso de ese módulo y verificar consumo |
| Total sin conversión | Respuesta exchange-rate, fecha, respaldo | Mostrar pendiente; no tratar cotización ausente como cero |
| Secundario separado | consumption_domains del titular | Corregir relación y recargar reporte |
| QR sin producto | Dominio, habilitación, código, fuente y precio | Validar API comercial y catálogo |
| Turno no aparece | Reserva/activación, sección, escritor | Revisar ticket e historial sin alterar contador |
| Mesa no acepta pedido | Visita activa, habilitación, flags | Revisar sesión y confirmación del operador |
| HubSpot no publica | Credencial backend, permisos, bloqueo de borrador | Consultar estado remoto antes de repetir |

Antes de modificar datos: verificar host/base y objetivo; registrar estado previo; aplicar modificación mínima; releer y probar desde la aplicación. Para backups usar el mecanismo administrado (`asisto-backup.service`/timer cuando estén presentes), comprobar fecha y restaurabilidad en entorno aislado. Este manual no certifica una restauración por el mero hecho de existir un backup.

## 17. Mantenimiento del manual

Este archivo es la entrada canónica. Cada cambio de ruta, parámetro, autenticación, variable, default, instalación o facturación debe actualizarlo o actualizar su anexo funcional en el mismo cambio de código.

```powershell
node scripts/build_technical_manual.cjs
git diff -- docs
```

El generador actualiza inventarios de rutas literales, variables de entorno referenciadas, colecciones y ayuda de variables de dominio. No sustituye revisión humana de contratos, no ejecuta APIs y no consulta producción. Revisar rutas dinámicas/aliases y contratos externos a mano. No presentar un endpoint detectado como habilitado sin comprobar su montaje.

En cada entrega registrar: comportamiento anterior/nuevo, módulos afectados, configuración nueva, necesidad de reinicio/migración, pruebas y versión publicada. Cuando una función está prevista, marcarla pendiente hasta verificarla. Las URLs de proveedores, tarifas y compatibilidad deben comprobarse al intervenir, no perpetuarse como verdades fijas.

Historial documental: edición inicial reúne operación AWS, alta de cliente, módulos, integraciones y catálogos regenerables. Referencias antiguas se conservan para contexto, con prioridad del código vigente y de la infraestructura verificada.
<!-- Actualización 2026-10-22 / 5.00.307: soporte ALSO/DEMJG/SANA -->
La revisión de objetivos conserva mensajes originales, valida cobertura y exige evidencia de resolución. El script scripts/review_support_generated.cjs es dry-run por defecto; --apply respalda cifrado en support_audit y encola jobs con generatedRepairOnly y reviewMessageIds. Preserva ediciones humanas y registros HubSpot guardados/enviándose/inciertos. No realiza escrituras HubSpot ni cambios de vinculación. Extensión 1.0.61 agrega taskStatus sin cambiar el estado de persistencia pendiente/guardado. Ver docs/whatsapp_support.md.

<!-- 5.00.308: reparación explícita admite membresías automáticas cruzadas, mantiene cobertura e IDs únicos de revisión. Mini exige esquema estricto. No relaja protección de ediciones ni HubSpot. -->
<!-- 5.00.309: preflight de todos los resúmenes antes de escribir membresías durante reparación generada; consumo rechazado validado se contabiliza. -->

Centro de actividad: ver [CENTRO_ACTIVIDAD_APP.md](CENTRO_ACTIVIDAD_APP.md).

### Registro de pruebas NEA (2026-11-05)

Desde v5.00.333, cada envío de NEA_PRUEBAS se registra en AWS Cluster0, colección bot_test_history: dominio, sesión, usuario técnico, fecha, consulta, modelo configurado, respuesta, duración y estado pending/completed/failed. Se escribe antes de llamar al bot; los errores no guardan payloads del proveedor ni claves. Un fallo de persistencia devuelve error visible. Reiniciar conversación no borra el historial. No recupera consultas anteriores; una interrupción puede dejar estado pending. Sin vencimiento automático. El análisis se realiza administrativamente en AWS, filtrando tenant y sessionId; no existe todavía pantalla de historial ni exportación. No usar datos sensibles reales en pruebas. Este registro está habilitado únicamente para NEA_PRUEBAS y no escribe en conversaciones de WhatsApp.

### Seguimiento: alcance del listado (v5.00.334)

Seguimiento presenta exclusivamente conversaciones en modo conversacional (WhatsApp y QR web), incluidas las derivadas a atención manual y finalizadas. No consulta ni mezcla ventanas de envíos automáticos por API; el filtro de canal ya no ofrece API Mensajes. Los envíos conservan registros, métricas y facturación. Los endpoints históricos de ventanas se conservan por compatibilidad, pero el panel no los utiliza. Aplica a todos los dominios. NEA_PRUEBAS conserva su historial separado de simulación. El módulo se sirve desde el backend central AWS; el servidor turnero local de Mecan no monta este módulo.

### Pruebas NEA en Seguimiento (v5.00.335)

En NEA y NEA_PRUEBAS aparece un bloque de pruebas agrupadas por sesión y usuario, con última consulta, fecha, cantidad y errores. Ver prueba muestra consulta/respuesta cronológicas y estados fallidos o pendientes. Solo lectura: no permite enviar, cerrar, clasificar ni modificar la conversación real. Los indicadores y filtros operativos siguen correspondiendo a atención real; las pruebas utilizan búsqueda textual y rango de fechas sobre consultas, con detalle de sesión completa hasta 1000 consultas y listado de hasta 500 sesiones. Se leen registros existentes de bot_test_history sin copiarlos a conversations. Rutas GET /api/conversation-followup/pilot-sessions y /pilot-sessions/:id bajo permiso followup, resolución del dominio autorizado y restricción NEA/NEA_PRUEBAS; otros dominios reciben 403. Requiere backend central AWS; no cambia WhatsApp ni turnero local.

### Evaluación normal de pruebas (v5.00.336, reemplaza v335)

Las pruebas ahora aparecen en la tabla normal y usan conversation_followups, clasificación IA, gestión, tipo, cotización, satisfacción, notas y cierre. Filtro Origen Todas/Reales/Pruebas y canal Pruebas Bot; indicadores según filtro. El historial se proyecta idempotentemente a conversations/messages exclusivamente bajo NEA_PRUEBAS, con isTest=true y channelType=bot_test. NEA puede listar y gestionar esas pruebas mediante resolución acotada por ID; otros dominios no. Los nuevos intercambios se proyectan al completarse; reintentos no duplican ni reabren cierres sin actividad nueva. El canal bloquea entregas en servidor y oculta el compositor. Clasificación provisoria y final usan la misma lógica que conversaciones normales (satisfacción neutral no implica evidencia positiva). No se modifican conversaciones reales ni se conectan canales.

Desde v5.00.337 el filtro Origen está en la barra de filtros de Seguimiento, con el mismo desplegable que Canal/Estado/Gestión/Tipo. Selección exclusiva Todas/Reales/Pruebas; al elegir cierra el menú y actualiza listado e indicadores. Conserva los filtros restantes y el diseño adaptable.

### Indices de CPU centrales (2026-11-06)

Aplicados a AWS Cluster0 11 índices no únicos, sin eliminar índices ni datos. Catálogo reproducible: scripts/sync_cpu_indexes.cjs, función syncCpuIndexes(db), idempotente por clave. Cubre soporte (queued, recuperación historical/catchup, fecha), contactos jid/aliases, tenant_config tenantId/tenantid y confirmaciones por origen/día/pedidoAt. Se ejecuta únicamente contra la base central autorizada, no sobre copias de otras PCs. No requiere despliegue de backend ni cambios MCN/turnero local: los índices viven en la base autoritativa. Validado con consultas reales y explain, sin exponer sus valores; historial de prueba idempotente no constituye prueba de recuperación de créditos AWS. El agotamiento de ráfaga requiere seguimiento de la métrica de Lightsail; no se modificó el plan.

Segunda ronda 2026-11-06: catálogo ampliado a 14 índices con tenantId/updatedAt de queue_tickets y dos índices de ventanas WhatsApp. Validación: turnos 1743→29 documentos, historial 1743→117, ventanas ordenadas 408→100 para límite 100. La consulta multikey por fecha no mostró reducción (2456 documentos); no se forzó plan ni se alteró la consulta. Créditos AWS aún 0.01% a las 16:30 ART, CPU 20%; recuperación no demostrada.

### Plan ventanas por fecha v5.00.339

El proxy de agentes aplica hint exclusivamente a find de wa_api_message_windows con channelType=api_messages y messages.at con ambos límites. Requiere índice cpu_20261106_tenantId_numeroFrom_channelType_messages.at antes de publicar; scripts/sync_cpu_indexes.cjs lo reproduce. No cambia filtro, dominio, número, orden ni límites. Comparación real completa de IDs de muestra fue idéntica (65). Mongo rechazó la gestión administrativa de planes; no se ampliaron permisos y se implementó la elección en la consulta. Rollback mediante release anterior elimina el hint. El módulo solo existe en backend central AWS; turnero local no contiene endpoint.js.

En v5.00.340 la consulta acotada del agente usa messages/$elemMatch/at para que ambos límites del rango correspondan al mismo mensaje y el índice multikey combine los bounds. No altera los mensajes ni importes: elimina posibles ventanas candidatas sin mensajes dentro del rango. En la muestra real ambos filtros devolvieron los mismos 66 IDs y el nuevo examinó 66 documentos en 0 ms.

### Reducción de tráfico de agentes (v5.00.341 / agente v4.05.44–45)

El middleware de autenticación sigue leyendo la credencial en cada solicitud y conserva comparación segura y precedencia de aliases, pero proyecta únicamente los ocho campos de credenciales. No mantiene caché de autorización: la revocación continúa siendo inmediata. El proxy registra cada minuto cantidades, bytes y tiempo agregado por colección/operación bajo WWEB_AGENT_TRAFFIC, sin consultas, tokens, teléfonos ni contenido. Sirve para identificar volumen y transferencia sin activar un profiler pesado.

El agente 4.05.44 conserva por 30 segundos el ping de disponibilidad si configure recibe la misma conexión; cambios de URL, token, tenant o número invalidan la caché. Esto no omite la autenticación del servidor para las consultas reales. El agente 4.05.45 evita dos fallbacks equivalentes de políticas en Control API (el servidor ya impone el ID canónico), conservando los fallbacks para Mongo directo. Los contadores de no-contactos y circuit breaker proyectan únicamente ID o estado/motivo: mismos filtros, límites y decisiones, sin descargar adjuntos pendientes. No se alteran cupos, horarios, confirmaciones, documentos enviados ni tarifas. Verificar runtimeVersion en wa_locks; release_tag/desiredTag no demuestran instalación. Rollout mediante actualizador existente, sin habilitarlo en equipos donde estaba desactivado.

Pruebas: aliases/precedencia y revocación de credenciales; aislamiento tenant/número con API Strict; caché ping con expiración/invalidez; política canónica y fallbacks directos; decisiones de contadores; regresión de cupos, horarios, custodia y actualización segura. Las métricas de CPU y créditos se verifican separadamente en Lightsail: menor tráfico no demuestra recuperación por sí solo.

Actualización de índices 2026-11-06: catálogo central ampliado a 16 índices, agregando confirmaciones por tenant/origen/estado/pedidoAt y diferidos por tenant/origen/activo/nextAt. Comparación real RVL con mismos conjuntos completos de IDs: aceptados 837→446 documentos examinados (9 coincidencias), timeouts 646→139 (14), diferidos 837→216 (216). Los índices no únicos son aditivos; no se eliminaron ni modificaron documentos. El tiempo aislado no bajó uniformemente; no se presenta como mejora de latencia probada. Se conservaron exactamente 5 releases por servicio, incluida la activa; no se tocaron respaldos de base.

Validación operativa del 06/11/2026: backend AWS activo v5.00.341; 29 sesiones activas reportan runtimeVersion 4.05.45 (SDG, CHIAROTTO, FLEMING_SF, FLEMING_SASTRE, GPN, RVL, NEA/NEA2, PEV1–5, LVR2, TFG/TFG1/TFG2, LBS1, RDV1–4, DEMO_FERRETERIA, BANB, AGC1–5). AGC tenía target_tag=v4.05.40 con precedencia sobre auto_update_target_tag; ambos aliases quedaron consistentes en v4.05.45. No se cambiaron flags de habilitación, cupos ni franjas. Los registros previos de configuración se guardaron en el servidor para reversión. Ping pasó de ~38/s a 0,82/s en muestra de 60 segundos. La recuperación de créditos debe confirmarse con punto fechado de Lightsail, no inferirse de esas tasas. Healthz público de asisto.com.ar y www.asistobot.com.ar respondió ok; nginx validado y servicios activos.

Recuperación inicial confirmada en la consola Lightsail de la cuenta Asisto 401905376919: BurstCapacityPercentage 0,01% a las 17:55 ART y 0,02% a las 18:00 ART del 06/11/2026. Es un primer aumento pequeño, no una reserva ya recuperada ni garantía bajo otras cargas. Con las 29 sesiones en 4.05.45, muestra pidstat de 15 s: Node 20,93% y MongoDB 10,47% de un núcleo (servidor de 2 vCPU); vmstat posterior mayormente 12–19% total. El plan AWS y las reglas de envío no se modificaron. Estado final: producción/turnero/nginx/MongoDB activos, healthz de ambos dominios públicos correcto; exactamente 5 releases conservadas por servicio.

### Archivo de Pruebas Bot (v5.00.343)

El simulador guarda cada consulta antes de invocar al modelo, bajo el dominio autorizado. Seguimiento la muestra con Origen: Pruebas; conserva la agrupacion NEA / NEA_PRUEBAS y los IDs historicos. Los resultados se proyectan sin duplicados y no se mezclan con la bandeja de WhatsApp. Una respuesta completada no se marca fallida ante un error posterior. Reproyectar bot_test_history con syncPilotRecord si falla la proyeccion. Se recuperaron 43 intercambios completos (42 de NEA y uno de NEA_PRUEBAS) desde memoria y registros del servidor, cotejados con las trazas. Con el intercambio preexistente, la API de Seguimiento devuelve seis chats y 88 mensajes para NEA. Repetir la recuperación no inserta duplicados. Las trazas de uso por sí solas no contienen el diálogo. Turnero local Mecan no monta el simulador.
