# Inventario generado desde el código

Regenerar: `node scripts/build_technical_manual.cjs`. No contiene valores de producción.

## Variables de dominio con descripción del panel

Se guardan en `tenant_config`, salvo indicación del módulo. Descripciones tomadas de la ayuda existente; no implican valores productivos. Los secretos se configuran por el canal seguro correspondiente. JSON usa booleanos `true`/`false`, números sin comillas y listas reales.

| Campo | Función / reglas |
|---|---|
| `actualiza` | URL alternativa o histórica usada para actualizar estados. |
| `api` | URL del API principal que procesa mensajes entrantes. |
| `api_mensajes_alta` | URL que registra nuevos mensajes en Api_Mensajes/Alta. |
| `api_mensajes_alta_key` | Clave de autenticación específica del API de Alta. |
| `api_mensajes_alta_nro_tel_from` | Número emisor utilizado al registrar mensajes mediante Alta. |
| `api_mensajes_circuit_antiguedad_ms` | Antigüedad mínima, en milisegundos, para considerar una solicitud sin respuesta. |
| `api_mensajes_circuit_fallos_consecutivos` | Cantidad de fallos consecutivos que detiene temporalmente el lote. |
| `api_mensajes_circuit_min_muestra` | Cantidad mínima de solicitudes evaluadas antes de activar el circuit breaker. |
| `api_mensajes_circuit_sin_respuesta_ratio` | Proporción de solicitudes sin respuesta que detiene el lote. Rango: 0 a 1. |
| `api_mensajes_confirmacion_habilitada` | Activa la solicitud de permiso antes de enviar mensajes automáticos. |
| `api_mensajes_confirmacion_mensaje` | Texto principal utilizado para solicitar autorización al cliente. |
| `api_mensajes_confirmacion_mensajes` | Lista de variantes del mensaje de autorización; el cliente elige una para evitar repeticiones. |
| `api_mensajes_confirmacion_prioridades` | Lista de prioridades que requieren confirmación. Ejemplo: [3]. Si no existe, se confirman todas. |
| `api_mensajes_confirmacion_reenviar_ms` | Tiempo en milisegundos antes de permitir otra solicitud de autorización. |
| `api_mensajes_confirmacion_respuestas_ok` | Respuestas que se consideran autorización, por ejemplo OK, SI o SÍ. |
| `api_mensajes_confirmacion_validez_ms` | Duración en milisegundos de una autorización concedida. |
| `api_mensajes_historial_whatsapp_limite` | Cantidad máxima de mensajes del chat que se revisan para buscar historial u OK. |
| `api_mensajes_limite_diario` | Máximo diario de mensajes automáticos. 0 significa sin límite. |
| `api_mensajes_limite_no_contactos` | Máximo diario de solicitudes a números sin contacto ni historial. |
| `api_mensajes_requerir_contacto_o_historial` | Exige contacto agendado o conversación previa cuando no se usa confirmación. |
| `api_mensajes_respuestas_baja` | Palabras que solicitan exclusión permanente; se evalúan según las reglas de BAJA. |
| `api_mensajes_window_currency` | Moneda usada para valorar las ventanas, por ejemplo ARS o USD. |
| `api_mensajes_window_minutes` | Duración en minutos de la ventana usada para métricas o facturación. |
| `api_mensajes_window_value` | Valor monetario asignado a cada ventana de mensajes. |
| `api2` | URL del API que consulta mensajes salientes pendientes. |
| `api3` | URL del API que actualiza el estado de los destinatarios. |
| `cant_lim` | Cantidad límite utilizada por procesos históricos del cliente. |
| `CHAT_MODEL` | Modelo utilizado para conversaciones de texto. |
| `compra_mensajes_usar_api_alta` | Si es true, las notificaciones de compra se registran en el API de Alta; si es false, se envían directamente por WhatsApp. |
| `consulta_mensajes_respetar_horarios` | Si es true, la consulta de mensajes respeta los horarios configurados. |
| `control_api_enabled` | Habilita la API remota de control del cliente. |
| `control_api_token` | Token secreto de acceso a la API de control. |
| `control_api_url` | Dirección de la API remota de control. |
| `direccion` | Dirección o ubicación informativa de la empresa. |
| `dsn` | Nombre del origen ODBC usado para conectar con Manager. |
| `email_err` | Correo que recibe avisos de error. |
| `entrega_mensajes_usar_api_alta` | Si es true, las notificaciones de entrega se registran en el API de Alta; si es false, se envían directamente por WhatsApp. |
| `es_mensajes_usar_api_alta` | Si es true, los registros de es_mensajes se envían mediante el API de Alta; si es false, el script los envía directamente por WhatsApp, incluyendo el adjunto con el texto como descripción. |
| `habilitar_bot` | Activa o desactiva el procesamiento automático de mensajes entrantes. |
| `habilitar_consulta_mensajes` | Activa la consulta y envío de mensajes pendientes desde la API. |
| `habilitar_mensajes_info` | Activa el procesamiento del origen local es_mensajes. |
| `habilitar_odbc_manager` | Habilita la conexión ODBC con la base de Manager. |
| `headless` | Define si el navegador de WhatsApp Web se ejecuta sin ventana visible. |
| `heartbeat_ms` | Frecuencia en milisegundos con que el cliente informa que sigue activo. |
| `help_enabled` | Activa las herramientas internas de ayuda basadas en IA. |
| `key` | Clave utilizada para autenticar las APIs de mensajes. |
| `lease_ms` | Duración del permiso de ejecución exclusivo antes de considerarlo vencido. |
| `msg_cad` | Mensaje enviado cuando una interacción caduca. |
| `msg_can` | Mensaje de cancelación. |
| `msg_fin` | Mensaje utilizado al finalizar una interacción. |
| `msg_inicio` | Mensaje mostrado al iniciar una interacción. |
| `msg_lim` | Mensaje mostrado al alcanzar un límite. |
| `nom_emp` | Nombre de la empresa que se muestra en paneles y mensajes. |
| `numero` | Número de WhatsApp asociado al dominio, con código de país. |
| `OPENAI_MAX_TOKENS` | Máximo de tokens que puede generar el modelo en una respuesta. |
| `OPENAI_TEMPERATURE` | Nivel de variación de las respuestas del modelo. |
| `OPENAI_TRANSCRIBE_MODEL` | Modelo utilizado para transcribir audios. |
| `panel_restart_mode` | Modo utilizado por el panel para reiniciar el agente. |
| `puerto` | Puerto HTTP local utilizado por el agente. |
| `queue_counter_reset_daily` | Controla la numeración del turnero. true: cada sección vuelve a 001 al comenzar un nuevo día. false: la numeración continúa desde el último número utilizado, aunque cambie la fecha. |
| `release_tag` | Versión del script cliente que debe instalar automáticamente este dominio. |
| `restaurant_ai_model` | Modelo de IA para consultas de carta y asistencia al operario. |
| `restaurant_call_waiter_enabled` | Llamar al mozo. Valores: true / false. Por defecto: true. |
| `restaurant_display_name` | Nombre visible en la carta. Vacío: nombre de la empresa. |
| `restaurant_enabled` | Habilita el módulo Restaurante para este dominio. Ausente: deshabilitado. |
| `restaurant_guest_ai_enabled` | IA del cliente. Valores: true / false. Por defecto: true. |
| `restaurant_guest_auto_approval` | Habilitación automática de celulares: true habilita al escanear si la mesa está abierta; false requiere aprobación del operador. Cerrar la mesa siempre revoca el acceso. Por defecto false. |
| `restaurant_guest_notifications_enabled` | Avisos a clientes con la carta abierta. Valores: true / false. Por defecto: true. |
| `restaurant_kitchen_board_enabled` | Vista de cocina. Valores: true / false. Por defecto: true. |
| `restaurant_logo_url` | Logo de este restaurante: URL HTTPS pública o ruta /static/. Vacío: logo de ejemplo. |
| `restaurant_manual_payments_enabled` | Registro manual de pagos. Valores: true / false. Por defecto: true. |
| `restaurant_mercadopago_enabled` | Mercado Pago (botón informativo, todavía sin cobro). Valores: true / false. Por defecto: true. |
| `restaurant_operator_ai_enabled` | IA del operario. Valores: true / false. Por defecto: true. |
| `restaurant_order_confirmation_required` | Los pedidos del celular requieren confirmación del operador antes de aparecer en cocina. Por defecto true. |
| `restaurant_order_tracking_enabled` | Seguimiento y resumen de cuenta. Valores: true / false. Por defecto: true. |
| `restaurant_orders_enabled` | Pedidos desde el celular. Valores: true / false. Por defecto: true. |
| `restaurant_request_bill_enabled` | Pedir la cuenta. Valores: true / false. Por defecto: true. |
| `restaurant_show_images` | Mostrar fotos de los platos. Valores: true / false. Por defecto: true. |
| `restaurant_split_bill_enabled` | Calculadora para dividir la cuenta. Valores: true / false. Por defecto: true. |
| `restaurant_tagline` | Frase breve debajo del nombre de la carta. |
| `restaurant_visit_hours` | Duración máxima de una visita QR desde su apertura, entre 1 y 24 horas. Cerrar la mesa revoca siempre todos los accesos. |
| `script` | Nombre del script principal del cliente. |
| `seg_desde` | Extremo del rango de espera entre envíos al mismo número, en milisegundos. |
| `seg_desde2` | Extremo del rango de espera entre clientes diferentes, en milisegundos. |
| `seg_hasta` | Otro extremo del rango de espera entre envíos al mismo número, en milisegundos. |
| `seg_hasta2` | Otro extremo del rango de espera entre clientes diferentes, en milisegundos. |
| `seg_msg` | Espera general o última espera calculada entre mensajes, en milisegundos. |
| `seg_tele` | Pausa base del ciclo de telemarketing o consultas, en milisegundos. |
| `telegram_bot_token` | Token secreto del bot de Telegram. |
| `telegram_bot_username` | Nombre público del bot de Telegram. |
| `time_cad` | Tiempo de caducidad de esperas conversacionales, en milisegundos. |
| `tl_activo` | Activa el componente histórico de Telegram. |
| `version` | Versión informativa reportada por la instalación. |
| `VISION_MODEL` | Modelo utilizado para analizar imágenes. |
| `ws_activo` | Activa el componente histórico de WhatsApp. |
| `wweb_engine` | Motor de WhatsApp Web. Valores habituales: wwebjs o baileys. |
| `wweb_message_log_retention_days` | Días que se conserva el historial técnico de WhatsApp Web. 0 significa no eliminar. |

`consumption_domains`: lista de dominios cuyos consumos se consolidan bajo este titular. Es independiente de permisos, canales y aliases de integración.

`token_cost_*_per_1k`: costo configurado por 1.000 tokens. `token_charge_*_per_1k`: tarifa legacy de cobro. Revisar precedencias de monetización en el manual principal.
