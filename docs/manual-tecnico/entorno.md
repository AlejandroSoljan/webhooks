# Inventario generado desde el código

Regenerar: `node scripts/build_technical_manual.cjs`. No contiene valores de producción.

## Variables detectadas

Referencias estáticas; que un nombre exista no significa que sea obligatorio o esté activo. Las variables indirectas, calculadas o seleccionadas mediante mapas requieren revisar su módulo.

| Variable | Referencias |
|---|---|
| `ADD_ENVIO_WITHOUT_ADDRESS` | [logic.js:1507](../../logic.js#L1507) |
| `APP_NAME` | [db.js:72](../../db.js#L72) |
| `ASISTO_AUTH_MODE` | [app_asisto_ws.js:177](../../app_asisto_ws.js#L177) |
| `ASISTO_AUTH_PATH` | [app_asisto_ws.js:176](../../app_asisto_ws.js#L176); [app_asisto_ws.js:831](../../app_asisto_ws.js#L831) |
| `ASISTO_CONFIG_COLLECTION` | [app_asisto_ws.js:148](../../app_asisto_ws.js#L148); [app_asisto_ws.js:637](../../app_asisto_ws.js#L637); [telegram_runtime.js:16](../../telegram_runtime.js#L16) |
| `ASISTO_DOMAIN_STATUS_API_KEY` | [endpoint.js:15](../../endpoint.js#L15); [help_tool.js:27](../../help_tool.js#L27) |
| `ASISTO_HELP_API_KEY` | [help_tool.js:25](../../help_tool.js#L25) |
| `ASISTO_OPENAI_API_KEY` | [fleteros_viajes_panel.js:1000](../../fleteros_viajes_panel.js#L1000) |
| `AUDIO_CACHE_TTL_MS` | [logic.js:29](../../logic.js#L29) |
| `AUTH_COOKIE_NAME` | [auth_ui.js:27](../../auth_ui.js#L27) |
| `AUTH_COOKIE_SECRET` | [auth_ui.js:28](../../auth_ui.js#L28); [src/support/crypto.js:31](../../src/support/crypto.js#L31); [src/support/crypto.js:43](../../src/support/crypto.js#L43) |
| `AUTO_UPDATE_BRANCH` | [app_asisto_ws.js:187](../../app_asisto_ws.js#L187) |
| `AUTO_UPDATE_CHECK_EVERY_MS` | [app_asisto_ws.js:188](../../app_asisto_ws.js#L188) |
| `AUTO_UPDATE_ENABLED` | [app_asisto_ws.js:184](../../app_asisto_ws.js#L184) |
| `AUTO_UPDATE_POST_UPDATE_CMD` | [app_asisto_ws.js:193](../../app_asisto_ws.js#L193) |
| `AUTO_UPDATE_REMOTE` | [app_asisto_ws.js:186](../../app_asisto_ws.js#L186) |
| `AUTO_UPDATE_REPO_PATH` | [app_asisto_ws.js:185](../../app_asisto_ws.js#L185) |
| `AUTO_UPDATE_REQUIRE_CLEAN` | [app_asisto_ws.js:191](../../app_asisto_ws.js#L191) |
| `AUTO_UPDATE_RESTART_ON_APPLY` | [app_asisto_ws.js:190](../../app_asisto_ws.js#L190) |
| `AUTO_UPDATE_RUN_NPM_INSTALL` | [app_asisto_ws.js:192](../../app_asisto_ws.js#L192) |
| `AUTO_UPDATE_STARTUP_DELAY_MS` | [app_asisto_ws.js:189](../../app_asisto_ws.js#L189) |
| `BACKUP_EVERY_MS` | [app_asisto_ws.js:175](../../app_asisto_ws.js#L175) |
| `BOT_MODE` | [logic.js:363](../../logic.js#L363) |
| `CALC_FIX_MAX_RETRIES` | [logic.js:25](../../logic.js#L25); [src/whatsapp/webhook.routes.js:282](../../src/whatsapp/webhook.routes.js#L282); [src/whatsapp/webhook.routes.js:283](../../src/whatsapp/webhook.routes.js#L283) |
| `CHAT_MAX_TOKENS` | [logic.js:16](../../logic.js#L16) |
| `CHAT_MODEL` | [conversation_followup_panel.js:340](../../conversation_followup_panel.js#L340); [logic.js:13](../../logic.js#L13) |
| `CLIENT_PHONE_ACCESS_CACHE_TTL_MS` | [client_phone_access.js:10](../../client_phone_access.js#L10) |
| `CLIENT_PHONE_ACCESS_MAX_NUMBERS` | [client_phone_access.js:11](../../client_phone_access.js#L11) |
| `COMPORTAMIENTO` | [logic.js:358](../../logic.js#L358) |
| `DB_NAME` | [src/script/migrate_products_tenant.js:7](../../src/script/migrate_products_tenant.js#L7) |
| `DEFAULT_CITY` | [endpoint.js:11873](../../endpoint.js#L11873); [endpoint.js:12293](../../endpoint.js#L12293); [logic.js:1531](../../logic.js#L1531); [logic.js:3089](../../logic.js#L3089); [src/whatsapp/webhook.routes.js:532](../../src/whatsapp/webhook.routes.js#L532); [src/whatsapp/webhook.routes.js:646](../../src/whatsapp/webhook.routes.js#L646) |
| `DEFAULT_COUNTRY` | [endpoint.js:11875](../../endpoint.js#L11875); [endpoint.js:12295](../../endpoint.js#L12295); [logic.js:1533](../../logic.js#L1533); [logic.js:3091](../../logic.js#L3091); [src/whatsapp/webhook.routes.js:534](../../src/whatsapp/webhook.routes.js#L534); [src/whatsapp/webhook.routes.js:648](../../src/whatsapp/webhook.routes.js#L648) |
| `DEFAULT_PROVINCE` | [endpoint.js:11874](../../endpoint.js#L11874); [endpoint.js:12294](../../endpoint.js#L12294); [logic.js:1532](../../logic.js#L1532); [logic.js:3090](../../logic.js#L3090); [src/whatsapp/webhook.routes.js:533](../../src/whatsapp/webhook.routes.js#L533); [src/whatsapp/webhook.routes.js:647](../../src/whatsapp/webhook.routes.js#L647) |
| `DEFAULT_TENANT` | [src/script/migrate_products_tenant.js:8](../../src/script/migrate_products_tenant.js#L8) |
| `DEMO_RODAVEN_API_KEY` | [demo_catalog_api.js:155](../../demo_catalog_api.js#L155); [demo_catalog_api.js:169](../../demo_catalog_api.js#L169) |
| `DEMO_RODAVEN_DATA_FILE` | [demo_catalog_api.js:43](../../demo_catalog_api.js#L43) |
| `DOMAIN_STATUS_API_KEY` | [endpoint.js:14](../../endpoint.js#L14); [help_tool.js:26](../../help_tool.js#L26) |
| `ENABLE_TELEGRAM` | [server.js:7](../../server.js#L7) |
| `ENDED_SESSION_TTL_MINUTES` | [logic.js:24](../../logic.js#L24) |
| `EXTERNAL_API_BODY_TEMPLATE` | [logic.js:388](../../logic.js#L388) |
| `EXTERNAL_API_ENABLED` | [logic.js:379](../../logic.js#L379) |
| `FIREBASE_CLIENT_EMAIL` | [customer_notifications.js:9](../../customer_notifications.js#L9) |
| `FIREBASE_PRIVATE_KEY` | [customer_notifications.js:9](../../customer_notifications.js#L9) |
| `FIREBASE_PROJECT_ID` | [customer_notifications.js:9](../../customer_notifications.js#L9) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | [customer_notifications.js:9](../../customer_notifications.js#L9) |
| `FLETEROS_API_KEY` | [fleteros_viajes_panel.js:30](../../fleteros_viajes_panel.js#L30) |
| `FLETEROS_API_URL` | [fleteros_viajes_panel.js:28](../../fleteros_viajes_panel.js#L28) |
| `FLETEROS_API_VERSION` | [fleteros_viajes_panel.js:29](../../fleteros_viajes_panel.js#L29) |
| `FLETEROS_TERCEROS_API_ENABLED` | [fleteros_viajes_panel.js:2613](../../fleteros_viajes_panel.js#L2613) |
| `FLETEROS_TERCEROS_API_TOKEN` | [fleteros_viajes_panel.js:2624](../../fleteros_viajes_panel.js#L2624) |
| `FLETEROS_TERCEROS_API_URL` | [fleteros_viajes_panel.js:1895](../../fleteros_viajes_panel.js#L1895); [fleteros_viajes_panel.js:2612](../../fleteros_viajes_panel.js#L2612) |
| `GOOGLE_MAPS_API_KEY` | [logic.js:36](../../logic.js#L36) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | [help_tool.js:441](../../help_tool.js#L441); [help_tool.js:554](../../help_tool.js#L554); [help_tool.js:2021](../../help_tool.js#L2021) |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | [help_tool.js:555](../../help_tool.js#L555) |
| `GRAPH_API_VERSION` | [logic.js:20](../../logic.js#L20); [wa_inbox_panel.js:18](../../wa_inbox_panel.js#L18) |
| `GRAPH_VERSION` | [logic.js:21](../../logic.js#L21) |
| `HEARTBEAT_MS` | [app_asisto_ws.js:174](../../app_asisto_ws.js#L174) |
| `HELP_API_KEY` | [help_tool.js:24](../../help_tool.js#L24) |
| `HELP_MODEL` | [help_tool.js:20](../../help_tool.js#L20) |
| `HELP_WEB_RATE_MAX` | [help_tool.js:37](../../help_tool.js#L37) |
| `HELP_WEB_RATE_WINDOW_MS` | [help_tool.js:36](../../help_tool.js#L36) |
| `HELP_WEB_SIGNING_SECRET` | [help_tool.js:34](../../help_tool.js#L34) |
| `HELP_WEB_TOKEN_TTL_MS` | [help_tool.js:35](../../help_tool.js#L35) |
| `HISTORY_MODE` | [logic.js:361](../../logic.js#L361) |
| `HUBSPOT_PORTAL_ID` | [src/support/hubspot_config.js:10](../../src/support/hubspot_config.js#L10) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | [src/support/hubspot_config.js:8](../../src/support/hubspot_config.js#L8) |
| `HUBSPOT_TENANT_ID` | [src/support/hubspot_config.js:7](../../src/support/hubspot_config.js#L7) |
| `INSTANCE_ID` | [app_asisto_ws.js:438](../../app_asisto_ws.js#L438); [telegram_runtime.js:15](../../telegram_runtime.js#L15) |
| `LEAD_CAPTURE_ENABLED` | [logic.js:367](../../logic.js#L367) |
| `LEAD_NOTIFY_WWEB_FROM` | [lead_notification.js:10](../../lead_notification.js#L10) |
| `LEAD_NOTIFY_WWEB_TENANT` | [lead_notification.js:9](../../lead_notification.js#L9) |
| `LEAD_NOTIFY_WWEB_TO` | [lead_notification.js:11](../../lead_notification.js#L11) |
| `LEASE_MS` | [app_asisto_ws.js:173](../../app_asisto_ws.js#L173) |
| `MANAGER_API_KEY` | [fleteros_viajes_panel.js:30](../../fleteros_viajes_panel.js#L30) |
| `MANAGER_API_URL` | [fleteros_viajes_panel.js:28](../../fleteros_viajes_panel.js#L28) |
| `MANAGER_API_VERSION` | [fleteros_viajes_panel.js:29](../../fleteros_viajes_panel.js#L29) |
| `MIN_LEASE_MS` | [app_asisto_ws.js:172](../../app_asisto_ws.js#L172) |
| `MONGO_DB` | [app_asisto_ws.js:60](../../app_asisto_ws.js#L60) |
| `MONGO_URI` | [app_asisto_ws.js:54](../../app_asisto_ws.js#L54); [src/script/migrate_products_tenant.js:6](../../src/script/migrate_products_tenant.js#L6) |
| `MONGODB_DBNAME` | [db.js:99](../../db.js#L99) |
| `MONGODB_FULL_IDLE_DISCONNECT_MS` | [db.js:20](../../db.js#L20) |
| `MONGODB_URI` | [db.js:86](../../db.js#L86); [db.js:133](../../db.js#L133); [src/support/config.js:17](../../src/support/config.js#L17) |
| `MP_SUBSCRIPTIONS_ACCESS_TOKEN` | [mercadopago_subscriptions.js:13](../../mercadopago_subscriptions.js#L13) |
| `MP_SUBSCRIPTIONS_MODE` | [mercadopago_subscriptions.js:12](../../mercadopago_subscriptions.js#L12) |
| `MP_SUBSCRIPTIONS_PUBLIC_URL` | [mercadopago_subscriptions.js:16](../../mercadopago_subscriptions.js#L16) |
| `MP_SUBSCRIPTIONS_TEST_PAYER_ID` | [mercadopago_subscriptions.js:15](../../mercadopago_subscriptions.js#L15) |
| `MP_SUBSCRIPTIONS_WEBHOOK_SECRET` | [mercadopago_subscriptions.js:14](../../mercadopago_subscriptions.js#L14) |
| `NODE_ENV` | [auth_ui.js:226](../../auth_ui.js#L226); [endpoint.js:10716](../../endpoint.js#L10716); [src/whatsapp/webhook.routes.js:79](../../src/whatsapp/webhook.routes.js#L79) |
| `NUMERO` | [app_asisto_ws.js:53](../../app_asisto_ws.js#L53); [telegram_runtime.js:356](../../telegram_runtime.js#L356) |
| `OPENAI_API_KEY` | [fleteros_viajes_panel.js:1000](../../fleteros_viajes_panel.js#L1000); [logic.js:12](../../logic.js#L12); [src/support/crypto.js:45](../../src/support/crypto.js#L45) |
| `OPENAI_CPE_MODEL` | [fleteros_viajes_panel.js:1004](../../fleteros_viajes_panel.js#L1004) |
| `OPENAI_MAX_TOKENS` | [logic.js:16](../../logic.js#L16) |
| `OPENAI_TEMPERATURE` | [logic.js:15](../../logic.js#L15) |
| `OPENAI_TRANSCRIBE_MODEL` | [logic.js:30](../../logic.js#L30) |
| `OPENAI_VISION_FALLBACK_MODEL` | [logic.js:1262](../../logic.js#L1262) |
| `ORDER_CONFIG_CACHE_TTL_MS` | [order_config.js:9](../../order_config.js#L9) |
| `PHONE_NUMBER_ID` | [logic.js:22](../../logic.js#L22); [wa_inbox_panel.js:19](../../wa_inbox_panel.js#L19) |
| `PORT` | [endpoint.js:12460](../../endpoint.js#L12460); [endpoint.js:12468](../../endpoint.js#L12468); [server.js:6](../../server.js#L6) |
| `PUBLIC_BASE_URL` | [auth_ui.js:24](../../auth_ui.js#L24); [customer_queue.js:65](../../customer_queue.js#L65); [endpoint.js:1855](../../endpoint.js#L1855); [restaurant.js:30](../../restaurant.js#L30); [restaurant.js:178](../../restaurant.js#L178); [restaurant.js:227](../../restaurant.js#L227); [restaurant.js:237](../../restaurant.js#L237); [src/support/config.js:8](../../src/support/config.js#L8) |
| `QR_CONFIG_CACHE_MS` | [qr_product_web.js:29](../../qr_product_web.js#L29) |
| `QR_PRODUCT_API_MAX_CONCURRENT` | [qr_product_web.js:32](../../qr_product_web.js#L32) |
| `QR_PRODUCT_API_QUEUE_MAX` | [qr_product_web.js:33](../../qr_product_web.js#L33) |
| `QR_PRODUCT_API_QUEUE_WAIT_MS` | [qr_product_web.js:34](../../qr_product_web.js#L34) |
| `QUEUE_OPEN_TENANTS` | [customer_queue.js:65](../../customer_queue.js#L65) |
| `QUEUE_PORT` | [turnero_server.js:31](../../turnero_server.js#L31) |
| `QUEUE_PRESENCE_SECRET` | [customer_queue.js:65](../../customer_queue.js#L65) |
| `QUEUE_PRINTER_NAME` | [queue_printer.js:28](../../queue_printer.js#L28) |
| `QUEUE_SERVER_PRINT` | [queue_printer.js:27](../../queue_printer.js#L27) |
| `QUEUE_SYNC_EVERY_MS` | [queue_cloud_sync.js:127](../../queue_cloud_sync.js#L127) |
| `QUEUE_SYNC_SECRET` | [customer_queue.js:28](../../customer_queue.js#L28); [queue_cloud_sync.js:82](../../queue_cloud_sync.js#L82); [queue_cloud_sync.js:127](../../queue_cloud_sync.js#L127) |
| `QUEUE_SYNC_TENANTS` | [queue_cloud_sync.js:82](../../queue_cloud_sync.js#L82); [queue_cloud_sync.js:127](../../queue_cloud_sync.js#L127) |
| `QUEUE_SYNC_URL` | [customer_queue.js:28](../../customer_queue.js#L28); [queue_cloud_sync.js:127](../../queue_cloud_sync.js#L127) |
| `RENDER_SERVICE_NAME` | [db.js:70](../../db.js#L70) |
| `SERVICE_NAME` | [db.js:71](../../db.js#L71) |
| `SIMULATED_NOW_ISO` | [logic.js:27](../../logic.js#L27) |
| `START_FALLBACK` | [logic.js:1464](../../logic.js#L1464) |
| `STATUS_TOKEN` | [app_asisto_ws.js:55](../../app_asisto_ws.js#L55); [telegram_runtime.js:199](../../telegram_runtime.js#L199); [telegram_runtime.js:357](../../telegram_runtime.js#L357) |
| `STORE_LAT` | [logic.js:34](../../logic.js#L34) |
| `STORE_LNG` | [logic.js:35](../../logic.js#L35) |
| `STORE_TZ` | [help_tool.js:31](../../help_tool.js#L31); [logic.js:26](../../logic.js#L26) |
| `SUPPORT_ACTIVE_KEY` | [src/support/crypto.js:36](../../src/support/crypto.js#L36); [src/support/crypto.js:37](../../src/support/crypto.js#L37) |
| `SUPPORT_ENABLED` | [src/support/config.js:13](../../src/support/config.js#L13) |
| `SUPPORT_ENCRYPTION_KEYS` | [src/support/crypto.js:36](../../src/support/crypto.js#L36); [src/support/crypto.js:37](../../src/support/crypto.js#L37) |
| `SUPPORT_HUBSPOT_ENABLED` | [src/support/routes.js:16](../../src/support/routes.js#L16) |
| `SUPPORT_PUBLIC_ORIGIN` | [src/support/config.js:8](../../src/support/config.js#L8) |
| `SUPPORT_TASK_MODEL` | [src/support/title_analyzer.js:21](../../src/support/title_analyzer.js#L21) |
| `SUPPORT_TRANSCRIBER_MODEL` | [src/support/baileys.js:162](../../src/support/baileys.js#L162); [src/support/transcriber.js:12](../../src/support/transcriber.js#L12) |
| `SUPPORT_TRANSCRIBER_TOKEN` | [src/support/baileys.js:164](../../src/support/baileys.js#L164) |
| `SUPPORT_TRANSCRIBER_URL` | [src/support/baileys.js:159](../../src/support/baileys.js#L159); [src/support/baileys.js:160](../../src/support/baileys.js#L160); [src/support/transcriber.js:11](../../src/support/transcriber.js#L11) |
| `TELEGRAM_BOT_TOKEN` | [telegram_runtime.js:354](../../telegram_runtime.js#L354) |
| `TELEGRAM_BOT_USERNAME` | [telegram_runtime.js:355](../../telegram_runtime.js#L355) |
| `TENANT_AI_CONFIG_CACHE_TTL_MS` | [logic.js:17](../../logic.js#L17) |
| `TENANT_ID` | [app_asisto_ws.js:52](../../app_asisto_ws.js#L52); [bot_test_panel.js:21](../../bot_test_panel.js#L21); [bot_test_panel.js:47](../../bot_test_panel.js#L47); [client_phone_access.js:194](../../client_phone_access.js#L194); [client_phone_access.js:195](../../client_phone_access.js#L195); [client_phone_access.js:198](../../client_phone_access.js#L198); [client_phone_access.js:203](../../client_phone_access.js#L203); [conversation_followup_panel.js:15](../../conversation_followup_panel.js#L15); [conversation_followup_panel.js:68](../../conversation_followup_panel.js#L68); [endpoint.js:41](../../endpoint.js#L41); [endpoint.js:1845](../../endpoint.js#L1845); [fleteros_viajes_panel.js:23](../../fleteros_viajes_panel.js#L23); [fleteros_viajes_panel.js:55](../../fleteros_viajes_panel.js#L55); [fleteros_viajes_panel.js:3017](../../fleteros_viajes_panel.js#L3017); [logic.js:32](../../logic.js#L32); [order_config_panel.js:30](../../order_config_panel.js#L30); [order_config_panel.js:31](../../order_config_panel.js#L31); [restaurant.js:23](../../restaurant.js#L23); [restaurant.js:222](../../restaurant.js#L222); [restaurant.js:232](../../restaurant.js#L232); [restaurant.js:258](../../restaurant.js#L258); [restaurant.js:266](../../restaurant.js#L266); [restaurant_operations.js:160](../../restaurant_operations.js#L160); [telegram_runtime.js:353](../../telegram_runtime.js#L353); [wa_inbox_panel.js:17](../../wa_inbox_panel.js#L17); [wa_inbox_panel.js:33](../../wa_inbox_panel.js#L33) |
| `TENANT_RUNTIME_CACHE_TTL_MS` | [tenant.js:9](../../tenant.js#L9); [tenant_runtime.js:10](../../tenant_runtime.js#L10) |
| `TG_ACTION_POLL_MS` | [telegram_runtime.js:19](../../telegram_runtime.js#L19) |
| `TG_API` | [telegram_runtime.js:358](../../telegram_runtime.js#L358) |
| `TG_API_KEY` | [telegram_runtime.js:361](../../telegram_runtime.js#L361) |
| `TG_API2` | [telegram_runtime.js:359](../../telegram_runtime.js#L359) |
| `TG_API3` | [telegram_runtime.js:360](../../telegram_runtime.js#L360) |
| `TG_CONFLICT_COOLDOWN_MS` | [telegram_runtime.js:22](../../telegram_runtime.js#L22) |
| `TG_EXPIRY_POLL_MS` | [telegram_runtime.js:20](../../telegram_runtime.js#L20) |
| `TG_HEARTBEAT_MS` | [telegram_runtime.js:18](../../telegram_runtime.js#L18) |
| `TG_LOCK_STALE_MS` | [telegram_runtime.js:21](../../telegram_runtime.js#L21) |
| `TG_POLLING_START_PREPARE_MS` | [telegram_runtime.js:24](../../telegram_runtime.js#L24) |
| `TG_POLLING_STOP_SETTLE_MS` | [telegram_runtime.js:23](../../telegram_runtime.js#L23) |
| `TG_REFRESH_CONFIG_MS` | [telegram_runtime.js:17](../../telegram_runtime.js#L17) |
| `TOKEN_COST_AUDIO_PER_MINUTE` | [logic.js:1183](../../logic.js#L1183) |
| `TOKEN_COST_HELP_INPUT_PER_1K` | [token_control_stats.js:14](../../token_control_stats.js#L14) |
| `TOKEN_COST_HELP_OUTPUT_PER_1K` | [token_control_stats.js:15](../../token_control_stats.js#L15) |
| `TOKEN_COST_TASKS_WS_INPUT_PER_1K` | [token_control_stats.js:19](../../token_control_stats.js#L19) |
| `TOKEN_COST_TASKS_WS_LUNA_INPUT_PER_1K` | [token_control_stats.js:21](../../token_control_stats.js#L21) |
| `TOKEN_COST_TASKS_WS_LUNA_OUTPUT_PER_1K` | [token_control_stats.js:22](../../token_control_stats.js#L22) |
| `TOKEN_COST_TASKS_WS_MODEL` | [token_control_stats.js:17](../../token_control_stats.js#L17) |
| `TOKEN_COST_TASKS_WS_OUTPUT_PER_1K` | [token_control_stats.js:20](../../token_control_stats.js#L20) |
| `TOKEN_COST_WHISPER_PER_MINUTE` | [logic.js:1183](../../logic.js#L1183) |
| `TRANSCRIBE_API_URL` | [logic.js:28](../../logic.js#L28) |
| `VERIFY_TOKEN` | [endpoint.js:11](../../endpoint.js#L11) |
| `VISION_MODEL` | [logic.js:14](../../logic.js#L14) |
| `WA_INBOX_UPLOAD_MAX_BYTES` | [wa_inbox_panel.js:21](../../wa_inbox_panel.js#L21) |
| `WHATSAPP_ACCESS_TOKEN` | [logic.js:31](../../logic.js#L31); [wa_inbox_panel.js:20](../../wa_inbox_panel.js#L20) |
| `WHATSAPP_APP_SECRET` | [endpoint.js:1835](../../endpoint.js#L1835); [endpoint.js:10715](../../endpoint.js#L10715); [src/whatsapp/webhook.routes.js:78](../../src/whatsapp/webhook.routes.js#L78) |
| `WHATSAPP_TOKEN` | [logic.js:31](../../logic.js#L31); [wa_inbox_panel.js:20](../../wa_inbox_panel.js#L20) |
| `WHATSAPP_VERIFY_TOKEN` | [endpoint.js:11](../../endpoint.js#L11) |
| `WHISPER_MODEL` | [logic.js:30](../../logic.js#L30) |
| `WWEB_AGENT_JSON_LIMIT` | [endpoint.js:687](../../endpoint.js#L687) |
| `WWEB_API_KEY` | [endpoint.js:12](../../endpoint.js#L12); [help_tool.js:28](../../help_tool.js#L28); [src/support/crypto.js:44](../../src/support/crypto.js#L44); [wweb_phone_access.js:60](../../wweb_phone_access.js#L60) |
| `WWEB_CONTROL_API_TIMEOUT_MS` | [wweb_control_client.js:58](../../wweb_control_client.js#L58) |
