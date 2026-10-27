# Inventario generado desde el código

Regenerar: `node scripts/build_technical_manual.cjs`. No contiene valores de producción.

## Rutas HTTP detectadas

Este índice estático no es un contrato OpenAPI: incluye rutas internas, posibles registros no montados y prefijos parciales. La columna final es un fragmento literal posterior a la ruta, no una certificación de autenticación. Verificar el montaje y el handler enlazado antes de integrar. No detecta todas las rutas construidas dinámicamente ni arrays de aliases.

| Método | Ruta declarada | Implementación | Inicio de registro / middleware |
|---|---|---|---|
| DELETE | `/api/leads/:id` | [auth_ui.js:3499](../../auth_ui.js#L3499) | `, requireAuth, requireAdmin, async (req, res) => {` |
| DELETE | `/api/leads/:id` | [auth_ui.js:5439](../../auth_ui.js#L5439) | `, requireAuth, requireAdmin, async (req, res) => {` |
| DELETE | `/api/products/:id` | [endpoint.js:7891](../../endpoint.js#L7891) | `, async (req, res) => {` |
| DELETE | `/api/products/:id` | [src/web/web_admin.routes.js:123](../../src/web/web_admin.routes.js#L123) | `, async (req, res) => {` |
| DELETE | `/api/tenant-channels/:id` | [endpoint.js:455](../../endpoint.js#L455) | `, auth.requireAdmin, async (req, res) => {` |
| DELETE | `/api/tenant-config` | [auth_ui.js:5211](../../auth_ui.js#L5211) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/.well-known/assetlinks.json` | [customer_app_web.js:114](../../customer_app_web.js#L114) | `, (_req, res) => res.sendFile(require('path').join(__dirname, 'static/turnero/assetlinks.json')));` |
| GET | `/` | [app_asisto_ws.js:529](../../app_asisto_ws.js#L529) | `, (req, res) => {` |
| GET | `/` | [endpoint.js:1863](../../endpoint.js#L1863) | `, async (req, res) => {` |
| GET | `/admin/billing` | [billing_subscriptions.js:84](../../billing_subscriptions.js#L84) | `, auth.requireAuth, requireSuper, (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(render` |
| GET | `/admin/bot-test` | [bot_test_panel.js:237](../../bot_test_panel.js#L237) | `, async (req, res) => {` |
| GET | `/admin/client-phone-access` | [client_phone_access.js:389](../../client_phone_access.js#L389) | `, requireAdmin, async (req, res) => {` |
| GET | `/admin/conversation` | [endpoint.js:7211](../../endpoint.js#L7211) | `, async (req, res) => {` |
| GET | `/admin/fleteros/viajes` | [fleteros_viajes_panel.js:2639](../../fleteros_viajes_panel.js#L2639) | `, requireAuth, async (req, res) => {` |
| GET | `/admin/followup` | [conversation_followup_panel.js:1083](../../conversation_followup_panel.js#L1083) | `, async (req, res) => {` |
| GET | `/admin/inbox` | [endpoint.js:4105](../../endpoint.js#L4105) | `, async (req, res) => {` |
| GET | `/admin/inbox` | [wa_inbox_panel.js:972](../../wa_inbox_panel.js#L972) | `, async (req, res) => {` |
| GET | `/admin/leads` | [auth_ui.js:5305](../../auth_ui.js#L5305) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/messages/:convId` | [endpoint.js:7487](../../endpoint.js#L7487) | `, async (req, res) => {` |
| GET | `/admin/monetization` | [monetization_config.js:45](../../monetization_config.js#L45) | `,auth.requireAuth,requireSuper,(_req,res)=>res.type('html').send(renderPage()));` |
| GET | `/admin/order-config` | [order_config_panel.js:309](../../order_config_panel.js#L309) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/admin/resto` | [restaurant.js:284](../../restaurant.js#L284) | `, (_req, res) => res.sendFile(path.join(__dirname, 'static', 'restaurant_panel.html')));` |
| GET | `/admin/support` | [src/support/routes.js:128](../../src/support/routes.js#L128) | `, (req, res) => {` |
| GET | `/admin/telegram` | [telegram_runtime.js:2255](../../telegram_runtime.js#L2255) | `, auth.requireAuth, auth.requireAdmin, async (_req, res) => {` |
| GET | `/admin/tenant-config` | [auth_ui.js:5001](../../auth_ui.js#L5001) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/ticket/:convId` | [endpoint.js:7523](../../endpoint.js#L7523) | `, async (req, res) => {` |
| GET | `/admin/token-control` | [token_control_stats.js:2676](../../token_control_stats.js#L2676) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/admin/users` | [auth_ui.js:3730](../../auth_ui.js#L3730) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/web-access` | [web_access_stats.js:508](../../web_access_stats.js#L508) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/wweb` | [auth_ui.js:5456](../../auth_ui.js#L5456) | `, requireAuth, (req, res, next) => hasAccess(req.user, 'wweb', 'support') ? next() : res.status(403).send('403` |
| GET | `/admin` | [endpoint.js:5284](../../endpoint.js#L5284) | `, async (req, res) => {` |
| GET | `/api/admin/conversation-meta` | [endpoint.js:4054](../../endpoint.js#L4054) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/conversations` | [wa_inbox_panel.js:987](../../wa_inbox_panel.js#L987) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/media/:msgId` | [wa_inbox_panel.js:1199](../../wa_inbox_panel.js#L1199) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/messages` | [wa_inbox_panel.js:1036](../../wa_inbox_panel.js#L1036) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/meta` | [wa_inbox_panel.js:998](../../wa_inbox_panel.js#L998) | `, async (req, res) => {` |
| GET | `/api/behavior` | [endpoint.js:9803](../../endpoint.js#L9803) | `, async (req, res) => {` |
| GET | `/api/behavior` | [src/web/web_admin.routes.js:416](../../src/web/web_admin.routes.js#L416) | `, async (req, res) => {` |
| GET | `/api/billing/accounts` | [billing_subscriptions.js:85](../../billing_subscriptions.js#L85) | `, auth.requireAuth, requireSuper, wrap(async (_req, res) => {` |
| GET | `/api/client-phone-access` | [client_phone_access.js:401](../../client_phone_access.js#L401) | `, requireAdmin, async (req, res) => {` |
| GET | `/api/conversation-followup/:id/history` | [conversation_followup_panel.js:1346](../../conversation_followup_panel.js#L1346) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/:id/messages` | [conversation_followup_panel.js:1330](../../conversation_followup_panel.js#L1330) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/:id` | [conversation_followup_panel.js:1370](../../conversation_followup_panel.js#L1370) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/api-message-window/:id` | [conversation_followup_panel.js:1297](../../conversation_followup_panel.js#L1297) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/api-message-windows` | [conversation_followup_panel.js:1242](../../conversation_followup_panel.js#L1242) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/config` | [conversation_followup_panel.js:1107](../../conversation_followup_panel.js#L1107) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/conversations` | [conversation_followup_panel.js:1133](../../conversation_followup_panel.js#L1133) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/version` | [conversation_followup_panel.js:1103](../../conversation_followup_panel.js#L1103) | `, (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/presence/:sessionId/status` | [customer_queue.js:179](../../customer_queue.js#L179) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/presence` | [customer_queue.js:150](../../customer_queue.js#L150) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/printer/status` | [customer_queue.js:272](../../customer_queue.js#L272) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/product-stats` | [product_insights_routes.js:9](../../product_insights_routes.js#L9) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/sellers` | [customer_queue.js:130](../../customer_queue.js#L130) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/state` | [customer_queue.js:220](../../customer_queue.js#L220) | `, state);` |
| GET | `/api/customer-app-admin/:tenant/stats` | [queue_stats.js:108](../../queue_stats.js#L108) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/tickets/:id/delivery` | [customer_queue.js:252](../../customer_queue.js#L252) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app/:tenant/config` | [customer_app_web.js:117](../../customer_app_web.js#L117) | `, async (req, res) => { try { const t=tenant(req.params.tenant),{ sellers: _privateSellers, ...publicConfig }=` |
| GET | `/api/customer-app/:tenant/presence/:sessionId/status` | [customer_queue.js:173](../../customer_queue.js#L173) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app/:tenant/queue` | [customer_queue.js:219](../../customer_queue.js#L219) | `, state);` |
| GET | `/api/customer-app/:tenant/tickets/:id` | [customer_queue.js:350](../../customer_queue.js#L350) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-notifications/:tenant` | [customer_notifications.js:16](../../customer_notifications.js#L16) | `,requireAuth,async(req,res)=>{try{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,t))return res` |
| GET | `/api/ext/ayuda` | [help_tool.js:2316](../../help_tool.js#L2316) | `, requireHelpExternalAccess, handleHelpQuery);` |
| GET | `/api/ext/domain-status` | [endpoint.js:1490](../../endpoint.js#L1490) | `, requireDomainStatusAccess, async (req, res) => {` |
| GET | `/api/ext/help/status` | [help_tool.js:2320](../../help_tool.js#L2320) | `, requireHelpExternalAccess, async (req, res) => {` |
| GET | `/api/ext/help` | [help_tool.js:2314](../../help_tool.js#L2314) | `, requireHelpExternalAccess, handleHelpQuery);` |
| GET | `/api/ext/qr/alternatives` | [qr_product_web.js:1615](../../qr_product_web.js#L1615) | `, async (req, res) => {` |
| GET | `/api/ext/qr/chat/messages` | [qr_product_web.js:1640](../../qr_product_web.js#L1640) | `, async (req, res) => {` |
| GET | `/api/ext/qr/product` | [qr_product_web.js:1567](../../qr_product_web.js#L1567) | `, async (req, res) => {` |
| GET | `/api/ext/qr/scanner-assets/:asset` | [qr_local_scanner.js:131](../../qr_local_scanner.js#L131) | `, (req, res) => {` |
| GET | `/api/ext/wweb/qr-image` | [endpoint.js:1648](../../endpoint.js#L1648) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/ext/wweb/qr` | [endpoint.js:1590](../../endpoint.js#L1590) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/ext/wweb/status` | [endpoint.js:1441](../../endpoint.js#L1441) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/fleteros/api-config` | [fleteros_viajes_panel.js:2710](../../fleteros_viajes_panel.js#L2710) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/search` | [fleteros_viajes_panel.js:2654](../../fleteros_viajes_panel.js#L2654) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/status` | [fleteros_viajes_panel.js:2684](../../fleteros_viajes_panel.js#L2684) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/viajes/:id` | [fleteros_viajes_panel.js:2950](../../fleteros_viajes_panel.js#L2950) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/viajes` | [fleteros_viajes_panel.js:2928](../../fleteros_viajes_panel.js#L2928) | `, requireAuth, async (req, res) => {` |
| GET | `/api/hours` | [endpoint.js:10325](../../endpoint.js#L10325) | `, async (req, res) => {` |
| GET | `/api/hours` | [src/web/web_admin.routes.js:494](../../src/web/web_admin.routes.js#L494) | `, async (req, res) => {` |
| GET | `/api/leads/:id` | [auth_ui.js:3480](../../auth_ui.js#L3480) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads/:id` | [auth_ui.js:5423](../../auth_ui.js#L5423) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads` | [auth_ui.js:3445](../../auth_ui.js#L3445) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads` | [auth_ui.js:5410](../../auth_ui.js#L5410) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/logs/conversations` | [endpoint.js:3745](../../endpoint.js#L3745) | `, async (req, res) => {` |
| GET | `/api/logs/messages` | [endpoint.js:4025](../../endpoint.js#L4025) | `, async (req, res) => {` |
| GET | `/api/logs/pedido` | [endpoint.js:5162](../../endpoint.js#L5162) | `, async (req, res) => {` |
| GET | `/api/media/:msgId` | [endpoint.js:3890](../../endpoint.js#L3890) | `, async (req, res) => {` |
| GET | `/api/monetization/config` | [monetization_config.js:47](../../monetization_config.js#L47) | `,auth.requireAuth,requireSuper,async(req,res)=>{const tenantId=tenant(req.query.tenantId);if(!tenantId)return ` |
| GET | `/api/monetization/summary` | [monetization_config.js:48](../../monetization_config.js#L48) | `,auth.requireAuth,async(req,res)=>{try{const {buildMonetizationSummary}=require('./monetization_engine'),isSup` |
| GET | `/api/monetization/tenants` | [monetization_config.js:46](../../monetization_config.js#L46) | `,auth.requireAuth,requireSuper,async(req,res)=>{const current=tenant(req.user?.tenantId),tenants=await listMon` |
| GET | `/api/operations-dashboard/tenants` | [operations_dashboard.js:265](../../operations_dashboard.js#L265) | `, requireAuth, async (req, res) => {` |
| GET | `/api/operations-dashboard` | [operations_dashboard.js:253](../../operations_dashboard.js#L253) | `, requireAuth, async (req, res) => {` |
| GET | `/api/order-config/current` | [order_config_panel.js:325](../../order_config_panel.js#L325) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/order-config/defaults` | [order_config_panel.js:320](../../order_config_panel.js#L320) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/products/domains` | [endpoint.js:7664](../../endpoint.js#L7664) | `, async (req, res) => {` |
| GET | `/api/products` | [endpoint.js:7673](../../endpoint.js#L7673) | `, async (req, res) => {` |
| GET | `/api/products` | [src/web/web_admin.routes.js:21](../../src/web/web_admin.routes.js#L21) | `, async (req, res) => {` |
| GET | `/api/public/resto/:tenant/:token/account` | [restaurant_operations.js:220](../../restaurant_operations.js#L220) | `, route(async (req, res) => {` |
| GET | `/api/public/resto/:tenant/:token/menu` | [restaurant.js:93](../../restaurant.js#L93) | `, async (req, res) => {` |
| GET | `/api/public/resto/:tenant/:token/notifications` | [restaurant.js:111](../../restaurant.js#L111) | `, async (req, res) => {` |
| GET | `/api/resto/domains` | [restaurant.js:62](../../restaurant.js#L62) | `, async (req, res) => {` |
| GET | `/api/resto/events` | [restaurant.js:257](../../restaurant.js#L257) | `, async (req, res) => {` |
| GET | `/api/resto/operations` | [restaurant_operations.js:170](../../restaurant_operations.js#L170) | `, route(async (req, res) => {` |
| GET | `/api/resto/qr-pdf` | [restaurant.js:230](../../restaurant.js#L230) | `, async (req, res) => {` |
| GET | `/api/resto/settings` | [restaurant_operations.js:168](../../restaurant_operations.js#L168) | `, route(async (req, res) => { const { config } = await context(req); res.json({ features:settings(config) }); ` |
| GET | `/api/resto/summary` | [restaurant.js:73](../../restaurant.js#L73) | `, async (req, res) => {` |
| GET | `/api/resto/tables/:id/qr` | [restaurant.js:221](../../restaurant.js#L221) | `, async (req, res) => {` |
| GET | `/api/resto/tables` | [restaurant.js:174](../../restaurant.js#L174) | `, async (req, res) => {` |
| GET | `/api/support/status` | [src/support/routes.js:97](../../src/support/routes.js#L97) | `, async (req, res) => {` |
| GET | `/api/tenant-channels` | [endpoint.js:359](../../endpoint.js#L359) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-channels` | [src/web/tenant_channels.routes.js:15](../../src/web/tenant_channels.routes.js#L15) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-config/whatsapp-metrics` | [auth_ui.js:5053](../../auth_ui.js#L5053) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-config` | [auth_ui.js:5089](../../auth_ui.js#L5089) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/tg/chats` | [telegram_runtime.js:2310](../../telegram_runtime.js#L2310) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tg/stats` | [telegram_runtime.js:2295](../../telegram_runtime.js#L2295) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tg/status` | [telegram_runtime.js:2263](../../telegram_runtime.js#L2263) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/token-control/api-message-windows` | [token_control_stats.js:2778](../../token_control_stats.js#L2778) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/conversations` | [token_control_stats.js:2753](../../token_control_stats.js#L2753) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/exchange-rate` | [token_control_stats.js:2720](../../token_control_stats.js#L2720) | `, requireAuth, requireTokenControlAccess, async (_req, res) => {` |
| GET | `/api/token-control/media/:id/content` | [token_control_media.js:65](../../token_control_media.js#L65) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| GET | `/api/token-control/media/:id` | [token_control_media.js:60](../../token_control_media.js#L60) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| GET | `/api/token-control/summary` | [token_control_stats.js:2697](../../token_control_stats.js#L2697) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/timeline` | [token_control_stats.js:2731](../../token_control_stats.js#L2731) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/web-access/summary` | [web_access_stats.js:517](../../web_access_stats.js#L517) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/wweb/history` | [auth_ui.js:6206](../../auth_ui.js#L6206) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/history` | [endpoint.js:1795](../../endpoint.js#L1795) | `, async (req, res) => {` |
| GET | `/api/wweb/locks` | [auth_ui.js:5699](../../auth_ui.js#L5699) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/qr` | [auth_ui.js:5794](../../auth_ui.js#L5794) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/sessions` | [endpoint.js:1378](../../endpoint.js#L1378) | `, async (req, res) => {` |
| GET | `/api/wweb/stats` | [auth_ui.js:6076](../../auth_ui.js#L6076) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/app` | [auth_ui.js:3605](../../auth_ui.js#L3605) | `, requireAuth, (req, res) => {` |
| GET | `/audit` | [src/support/routes.js:73](../../src/support/routes.js#L73) | `, route((req, s, scope) => s.col('audit').find(scope).sort({ at: -1 }).limit(100).toArray()));` |
| GET | `/cache/audio/:id` | [endpoint.js:2381](../../endpoint.js#L2381) | `, (req, res) => {` |
| GET | `/cache/media/:id` | [endpoint.js:2387](../../endpoint.js#L2387) | `, (req, res) => {` |
| GET | `/canales` | [endpoint.js:9423](../../endpoint.js#L9423) | `, async (req, res) => {` |
| GET | `/capabilities` | [src/support/routes.js:43](../../src/support/routes.js#L43) | `, (req, res) => res.json({ hubspotEnabled, ...req.supportScope }));` |
| GET | `/comportamiento-ui.js` | [endpoint.js:8913](../../endpoint.js#L8913) | `, (_req, res) => {` |
| GET | `/comportamiento` | [endpoint.js:9247](../../endpoint.js#L9247) | `, async (req, res) => {` |
| GET | `/comportamiento` | [src/web/web_admin.routes.js:360](../../src/web/web_admin.routes.js#L360) | `, async (req, res) => {` |
| GET | `/contact-control` | [src/support/extension.js:108](../../src/support/extension.js#L108) | `, route(async (req, s, scope) => {` |
| GET | `/customer-app/:tenant/` | [customer_queue.js:114](../../customer_queue.js#L114) | ` + mode, wrap(async (req, res) => {` |
| GET | `/customer-app/:tenant` | [customer_app_web.js:116](../../customer_app_web.js#L116) | `, (req, res) => { const t = tenant(req.params.tenant); if (!t) return res.status(400).send("Dominio inválido")` |
| GET | `/customer-app/download/android` | [customer_app_web.js:115](../../customer_app_web.js#L115) | `, (_req, res) => res.download(require('path').join(__dirname, 'Asisto-1.1.7.apk'), 'Asisto-1.1.7.apk'));` |
| GET | `/drafts/:id/evidence` | [src/support/routes.js:62](../../src/support/routes.js#L62) | `, route((req, s, scope) => s.evidence(scope, req.params.id)));` |
| GET | `/drafts/:id/mail` | [src/support/extension.js:51](../../src/support/extension.js#L51) | `, route(async (req,s,scope) => { const row = await rowFor(s,scope,req.params.id); return mailFactory(s).histor` |
| GET | `/drafts/:id` | [src/support/extension.js:149](../../src/support/extension.js#L149) | `, route(async (req, s, scope) => {` |
| GET | `/drafts` | [src/support/extension.js:82](../../src/support/extension.js#L82) | `, route(async (req, s, scope) => {` |
| GET | `/drafts` | [src/support/routes.js:61](../../src/support/routes.js#L61) | `, route((req, s, scope) => s.listDrafts(scope, req.query.before, req.query.view &#124;&#124; 'tasks')));` |
| GET | `/favicon.ico` | [endpoint.js:159](../../endpoint.js#L159) | `, (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "static", "favicon-asisto.` |
| GET | `/healthz` | [endpoint.js:2370](../../endpoint.js#L2370) | `, (_req, res) => res.json({ ok: true }));` |
| GET | `/healthz` | [turnero_server.js:29](../../turnero_server.js#L29) | `, async (_req, res) => {` |
| GET | `/history/status` | [src/support/routes.js:60](../../src/support/routes.js#L60) | `, route((req, s, scope) => s.historyStatus(scope, req.query.from, req.query.to)));` |
| GET | `/horarios` | [endpoint.js:8528](../../endpoint.js#L8528) | `, async (req, res) => {` |
| GET | `/horarios` | [src/web/web_admin.routes.js:233](../../src/web/web_admin.routes.js#L233) | `, async (req, res) => {` |
| GET | `/hubspot/companies/:id/tickets` | [src/support/routes.js:86](../../src/support/routes.js#L86) | `, route(async (req, s, scope) => (await client(s, scope)).companyTickets(req.params.id)));` |
| GET | `/hubspot/company-contacts` | [src/support/extension.js:260](../../src/support/extension.js#L260) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/company` | [src/support/extension.js:266](../../src/support/extension.js#L266) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/mail-contacts` | [src/support/extension.js:239](../../src/support/extension.js#L239) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/metadata` | [src/support/routes.js:85](../../src/support/routes.js#L85) | `, route(async (req, s, scope) => (await client(s, scope)).metadata()));` |
| GET | `/hubspot/search` | [src/support/extension.js:255](../../src/support/extension.js#L255) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot` | [src/support/extension.js:228](../../src/support/extension.js#L228) | `, route(async (req, s, scope) => {` |
| GET | `/index` | [src/support/extension.js:67](../../src/support/extension.js#L67) | `, route(async (req, s, scope) => {` |
| GET | `/jobs` | [src/support/routes.js:71](../../src/support/routes.js#L71) | `, route((req, s, scope) => s.col('jobs').find(scope, { projection: { claim: 0 } }).sort({ createdAt: -1 }).lim` |
| GET | `/login` | [auth_ui.js:3389](../../auth_ui.js#L3389) | `, (req, res) => {` |
| GET | `/mail/settings` | [src/support/extension.js:48](../../src/support/extension.js#L48) | `, route(async (req,s,scope) => mailFactory(s).view(scope)));` |
| GET | `/memory` | [src/support/routes.js:74](../../src/support/routes.js#L74) | `, route((req, s, scope) => s.col('memory').find(scope).limit(500).toArray()));` |
| GET | `/messages` | [src/support/extension.js:89](../../src/support/extension.js#L89) | `, route(async (req, s, scope) => {` |
| GET | `/novedades` | [endpoint.js:1872](../../endpoint.js#L1872) | `, (_req, res) => {` |
| GET | `/productos` | [endpoint.js:7942](../../endpoint.js#L7942) | `, async (req, res) => {` |
| GET | `/productos` | [src/web/web_admin.routes.js:174](../../src/web/web_admin.routes.js#L174) | `, async (req, res) => {` |
| GET | `/qr/:tenant/:codigo` | [qr_product_web.js:1516](../../qr_product_web.js#L1516) | `, async (req, res) => {` |
| GET | `/qr/:tenant` | [qr_product_web.js:1499](../../qr_product_web.js#L1499) | `, async (req, res) => {` |
| GET | `/r` | [web_access_stats.js:501](../../web_access_stats.js#L501) | `, async (req, res) => {` |
| GET | `/request/:code` | [src/support/devices.js:83](../../src/support/devices.js#L83) | `, route(async (req, s) => {` |
| GET | `/resto/:tenant/:token` | [restaurant.js:86](../../restaurant.js#L86) | `, async (req, res) => {` |
| GET | `/resto/image/:id` | [restaurant_image.js:27](../../restaurant_image.js#L27) | `, async (req, res) => {` |
| GET | `/robots.txt` | [auth_ui.js:3560](../../auth_ui.js#L3560) | `, (req, res) => {` |
| GET | `/robots.txt` | [endpoint.js:2344](../../endpoint.js#L2344) | `, (_req, res) => {` |
| GET | `/session` | [src/support/extension.js:63](../../src/support/extension.js#L63) | `, route(async (req, s, scope) => {` |
| GET | `/session` | [src/support/routes.js:47](../../src/support/routes.js#L47) | `, route(async (req, s, scope) => {` |
| GET | `/settings` | [src/support/routes.js:44](../../src/support/routes.js#L44) | `, route((req, s, scope) => s.config(scope)));` |
| GET | `/sitemap.xml` | [auth_ui.js:3582](../../auth_ui.js#L3582) | `, (req, res) => {` |
| GET | `/sitemap.xml` | [endpoint.js:2354](../../endpoint.js#L2354) | `, (_req, res) => {` |
| GET | `/status/lock` | [app_asisto_ws.js:752](../../app_asisto_ws.js#L752) | `, requireStatusToken, async (req, res) => {` |
| GET | `/status/qr` | [app_asisto_ws.js:757](../../app_asisto_ws.js#L757) | `, requireStatusToken, async (req, res) => {` |
| GET | `/status` | [app_asisto_ws.js:732](../../app_asisto_ws.js#L732) | `, requireStatusToken, async (req, res) => {` |
| GET | `/ui/:page` | [auth_ui.js:3657](../../auth_ui.js#L3657) | `, requireAuth, (req, res) => {` |
| GET | `/ui/configuracion` | [auth_ui.js:3649](../../auth_ui.js#L3649) | `, requireAuth, (req, res) => {` |
| GET | `/ui/notificaciones-app` | [customer_notifications.js:15](../../customer_notifications.js#L15) | `,requireAuth,async(req,res)=>{const isSuper=String(req.user?.role&#124;&#124;'').toLowerCase()==='superadmin',` |
| GET | `/ui/turnero/:tenant/estadisticas` | [queue_stats.js:97](../../queue_stats.js#L97) | `, wrap(async (req, res) => {` |
| GET | `/ui/turnero/:tenant/vendedores` | [customer_queue.js:125](../../customer_queue.js#L125) | `, wrap(async (req, res) => {` |
| GET | `/ui/turnero/:tenant` | [customer_queue.js:119](../../customer_queue.js#L119) | `, wrap(async (req, res) => {` |
| GET | `/usage` | [src/support/routes.js:72](../../src/support/routes.js#L72) | `, route((req, s, scope) => s.col('usage').find(scope).sort({ at: -1 }).limit(100).toArray()));` |
| GET | `/webhook` | [endpoint.js:10738](../../endpoint.js#L10738) | `, async (req, res) => {` |
| GET | `/webhook` | [src/whatsapp/webhook.routes.js:52](../../src/whatsapp/webhook.routes.js#L52) | `, async (req, res) => {` |
| GET | `/webhooks/mercadopago/subscriptions/return` | [billing_subscriptions.js:119](../../billing_subscriptions.js#L119) | `, (_req, res) => res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Asisto · M` |
| PATCH | `/api/customer-notifications/:tenant/devices/:installId` | [customer_notifications.js:17](../../customer_notifications.js#L17) | `,requireAuth,notificationJson,async(req,res)=>{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,` |
| PATCH | `/api/resto/events/:id` | [restaurant.js:265](../../restaurant.js#L265) | `, json, async (req, res) => {` |
| PATCH | `/drafts/:id` | [src/support/routes.js:63](../../src/support/routes.js#L63) | `, route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, req.body.fields)));` |
| POST | `/admin/leads/delete` | [auth_ui.js:5395](../../auth_ui.js#L5395) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/create` | [auth_ui.js:3753](../../auth_ui.js#L3753) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/delete` | [auth_ui.js:3919](../../auth_ui.js#L3919) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/reset-password` | [auth_ui.js:3880](../../auth_ui.js#L3880) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/update` | [auth_ui.js:3810](../../auth_ui.js#L3810) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api-chat-cab/procesar-mensaje` | [endpoint.js:10680](../../endpoint.js#L10680) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/api/admin/conversation-delivered` | [endpoint.js:4899](../../endpoint.js#L4899) | `, async (req, res) => {` |
| POST | `/api/admin/conversation-kitchen` | [endpoint.js:4948](../../endpoint.js#L4948) | `, async (req, res) => {` |
| POST | `/api/admin/conversation-manual` | [endpoint.js:4997](../../endpoint.js#L4997) | `, async (req, res) => {` |
| POST | `/api/admin/send-message` | [endpoint.js:5040](../../endpoint.js#L5040) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/finalize` | [wa_inbox_panel.js:1091](../../wa_inbox_panel.js#L1091) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/manual` | [wa_inbox_panel.js:1061](../../wa_inbox_panel.js#L1061) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/send-file` | [wa_inbox_panel.js:1157](../../wa_inbox_panel.js#L1157) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/send-message` | [wa_inbox_panel.js:1132](../../wa_inbox_panel.js#L1132) | `, async (req, res) => {` |
| POST | `/api/behavior/refresh-cache` | [endpoint.js:10128](../../endpoint.js#L10128) | `, async (req, res) => {` |
| POST | `/api/behavior/refresh-cache` | [src/web/web_admin.routes.js:446](../../src/web/web_admin.routes.js#L446) | `, async (req, res) => {` |
| POST | `/api/behavior` | [endpoint.js:9897](../../endpoint.js#L9897) | `, async (req, res) => {` |
| POST | `/api/behavior` | [src/web/web_admin.routes.js:426](../../src/web/web_admin.routes.js#L426) | `, async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/cancel-test` | [billing_subscriptions.js:112](../../billing_subscriptions.js#L112) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/reconcile` | [billing_subscriptions.js:106](../../billing_subscriptions.js#L106) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/test-subscription` | [billing_subscriptions.js:101](../../billing_subscriptions.js#L101) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/bot-test/reset` | [bot_test_panel.js:301](../../bot_test_panel.js#L301) | `, botTestJson, async (req, res) => {` |
| POST | `/api/bot-test/send` | [bot_test_panel.js:253](../../bot_test_panel.js#L253) | `, botTestJson, async (req, res) => {` |
| POST | `/api/client-phone-access` | [client_phone_access.js:411](../../client_phone_access.js#L411) | `, requireAdmin, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/classify` | [conversation_followup_panel.js:1492](../../conversation_followup_panel.js#L1492) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/close` | [conversation_followup_panel.js:1567](../../conversation_followup_panel.js#L1567) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/reopen` | [conversation_followup_panel.js:1397](../../conversation_followup_panel.js#L1397) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/send` | [conversation_followup_panel.js:1443](../../conversation_followup_panel.js#L1443) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id` | [conversation_followup_panel.js:1510](../../conversation_followup_panel.js#L1510) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/config` | [conversation_followup_panel.js:1118](../../conversation_followup_panel.js#L1118) | `, async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/sectors/:sector/:action` | [customer_queue.js:374](../../customer_queue.js#L374) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/settings` | [customer_queue.js:193](../../customer_queue.js#L193) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/tickets/:id/cancel` | [customer_queue.js:259](../../customer_queue.js#L259) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/tickets/:id/print` | [customer_queue.js:276](../../customer_queue.js#L276) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/devices` | [customer_app_web.js:118](../../customer_app_web.js#L118) | `, async (req,res)=>{ try{const t=tenant(req.params.tenant),installId=clean(req.body.installId,120),pushToken=c` |
| POST | `/api/customer-app/:tenant/presence/checkin` | [customer_queue.js:161](../../customer_queue.js#L161) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/cancel` | [customer_queue.js:359](../../customer_queue.js#L359) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/claim` | [customer_queue.js:310](../../customer_queue.js#L310) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [customer_queue.js:337](../../customer_queue.js#L337) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [deploy/mecan-install/patch-runtime.cjs:25](../../deploy/mecan-install/patch-runtime.cjs#L25) | `, wrap(async (req, res) => {", "  app.post('/api/customer-app/:tenant/tickets/:id/handoff', wrap(async (req, r` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [deploy/mecan-install/patch-runtime.cjs:25](../../deploy/mecan-install/patch-runtime.cjs#L25) | `, wrap(async (req, res) => {\n    const expiresAt = new Date(Date.now() + handoffDuration(req.body?.purpose));` |
| POST | `/api/customer-app/:tenant/tickets` | [customer_queue.js:221](../../customer_queue.js#L221) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-notifications/:tenant` | [customer_notifications.js:18](../../customer_notifications.js#L18) | `,requireAuth,notificationJson,async(req,res)=>{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,` |
| POST | `/api/ext/ayuda/chat-web` | [help_tool.js:2296](../../help_tool.js#L2296) | `, json, async (req, res) => {` |
| POST | `/api/ext/ayuda` | [help_tool.js:2317](../../help_tool.js#L2317) | `, json, requireHelpExternalAccess, handleHelpQuery);` |
| POST | `/api/ext/help` | [help_tool.js:2315](../../help_tool.js#L2315) | `, json, requireHelpExternalAccess, handleHelpQuery);` |
| POST | `/api/ext/qr/chat` | [qr_product_web.js:1690](../../qr_product_web.js#L1690) | `, qrJson, async (req, res) => {` |
| POST | `/api/ext/qr/photo` | [qr_product_web.js:1533](../../qr_product_web.js#L1533) | `, qrPhotoJson, async (req, res) => {` |
| POST | `/api/ext/queue-sequence` | [queue_cloud_sync.js:84](../../queue_cloud_sync.js#L84) | `, express.json({ limit: '8kb' }), async (req, res) => {` |
| POST | `/api/ext/queue-sync` | [queue_cloud_sync.js:96](../../queue_cloud_sync.js#L96) | `, express.json({ limit: '10mb' }), async (req, res) => {` |
| POST | `/api/ext/wweb/agent/bootstrap` | [endpoint.js:915](../../endpoint.js#L915) | `, wwebAgentJson, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/db` | [endpoint.js:985](../../endpoint.js#L985) | `, wwebAgentJson, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/operator-message` | [endpoint.js:1074](../../endpoint.js#L1074) | `, wwebAgentJson, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/ping` | [endpoint.js:974](../../endpoint.js#L974) | `, wwebAgentJson, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/chatgpt/process` | [endpoint.js:10678](../../endpoint.js#L10678) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/api/ext/wweb/manager/intent` | [endpoint.js:10682](../../endpoint.js#L10682) | `, async (req, res) => {` |
| POST | `/api/fleteros/api-config` | [fleteros_viajes_panel.js:2733](../../fleteros_viajes_panel.js#L2733) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/cpe/parse` | [fleteros_viajes_panel.js:2769](../../fleteros_viajes_panel.js#L2769) | `, requireAuth, maybeUploadCpe, async (req, res) => {` |
| POST | `/api/fleteros/seed-demo` | [fleteros_viajes_panel.js:2876](../../fleteros_viajes_panel.js#L2876) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/viajes/:id/sync-terceros` | [fleteros_viajes_panel.js:2848](../../fleteros_viajes_panel.js#L2848) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/viajes` | [fleteros_viajes_panel.js:2892](../../fleteros_viajes_panel.js#L2892) | `, requireAuth, async (req, res) => {` |
| POST | `/api/hours` | [endpoint.js:10345](../../endpoint.js#L10345) | `, async (req, res) => {` |
| POST | `/api/hours` | [src/web/web_admin.routes.js:514](../../src/web/web_admin.routes.js#L514) | `, async (req, res) => {` |
| POST | `/api/order-config/current` | [order_config_panel.js:336](../../order_config_panel.js#L336) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/products/:id/inactivate` | [endpoint.js:7908](../../endpoint.js#L7908) | `, async (req, res) => {` |
| POST | `/api/products/:id/inactivate` | [src/web/web_admin.routes.js:140](../../src/web/web_admin.routes.js#L140) | `, async (req, res) => {` |
| POST | `/api/products/:id/reactivate` | [endpoint.js:7925](../../endpoint.js#L7925) | `, async (req, res) => {` |
| POST | `/api/products/:id/reactivate` | [src/web/web_admin.routes.js:157](../../src/web/web_admin.routes.js#L157) | `, async (req, res) => {` |
| POST | `/api/products/bulk-save` | [endpoint.js:7789](../../endpoint.js#L7789) | `, async (req, res) => {` |
| POST | `/api/products/images` | [restaurant_image.js:13](../../restaurant_image.js#L13) | `, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), async (req, res) => {` |
| POST | `/api/products` | [endpoint.js:7692](../../endpoint.js#L7692) | `, async (req, res) => {` |
| POST | `/api/products` | [src/web/web_admin.routes.js:37](../../src/web/web_admin.routes.js#L37) | `, async (req, res) => {` |
| POST | `/api/public/resto/:tenant/:token/ask` | [restaurant.js:154](../../restaurant.js#L154) | `, json, async (req, res) => {` |
| POST | `/api/public/resto/:tenant/:token/events` | [restaurant.js:125](../../restaurant.js#L125) | `, json, async (req, res) => {` |
| POST | `/api/public/resto/:tenant/:token/scan` | [restaurant_operations.js:208](../../restaurant_operations.js#L208) | `,json,route(async(req,res)=>{` |
| POST | `/api/public/resto/:tenant/:token/visit` | [restaurant_operations.js:214](../../restaurant_operations.js#L214) | `, json, route(async(req,res)=>{` |
| POST | `/api/public/resto/:tenant/:token/visitors` | [restaurant.js:101](../../restaurant.js#L101) | `, json, async (req, res) => {` |
| POST | `/api/resto/devices` | [restaurant.js:211](../../restaurant.js#L211) | `, json, async (req, res) => {` |
| POST | `/api/resto/operations-ai` | [restaurant_operations.js:230](../../restaurant_operations.js#L230) | `, json, route(async (req, res) => {` |
| POST | `/api/resto/operations/:id` | [restaurant_operations.js:180](../../restaurant_operations.js#L180) | `, json, route(async (req, res) => {` |
| POST | `/api/resto/tables/:id/notifications` | [restaurant.js:184](../../restaurant.js#L184) | `, json, async (req, res) => {` |
| POST | `/api/resto/tables` | [restaurant.js:198](../../restaurant.js#L198) | `, json, async (req, res) => {` |
| POST | `/api/tenant-channels` | [endpoint.js:399](../../endpoint.js#L399) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tenant-channels` | [src/web/tenant_channels.routes.js:47](../../src/web/tenant_channels.routes.js#L47) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tenant-config` | [auth_ui.js:5123](../../auth_ui.js#L5123) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api/tg/policy` | [telegram_runtime.js:2394](../../telegram_runtime.js#L2394) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/release` | [telegram_runtime.js:2351](../../telegram_runtime.js#L2351) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/reload` | [telegram_runtime.js:2342](../../telegram_runtime.js#L2342) | `, auth.requireAuth, auth.requireAdmin, async (_req, res) => {` |
| POST | `/api/tg/restart` | [telegram_runtime.js:2378](../../telegram_runtime.js#L2378) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/start` | [telegram_runtime.js:2364](../../telegram_runtime.js#L2364) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/token-control/messages/:id/media` | [token_control_media.js:33](../../token_control_media.js#L33) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| POST | `/api/wweb/action` | [auth_ui.js:6239](../../auth_ui.js#L6239) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/delete-session` | [auth_ui.js:5910](../../auth_ui.js#L5910) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api/wweb/policy` | [auth_ui.js:5963](../../auth_ui.js#L5963) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/policy` | [endpoint.js:1730](../../endpoint.js#L1730) | `, async (req, res) => {` |
| POST | `/api/wweb/release` | [auth_ui.js:5838](../../auth_ui.js#L5838) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/release` | [endpoint.js:1771](../../endpoint.js#L1771) | `, async (req, res) => {` |
| POST | `/approve` | [src/support/devices.js:89](../../src/support/devices.js#L89) | `, route(async (req, s) => {` |
| POST | `/contact-control` | [src/support/extension.js:116](../../src/support/extension.js#L116) | `, route(async (req, s, scope) => {` |
| POST | `/contact` | [auth_ui.js:3401](../../auth_ui.js#L3401) | `, async (req, res) => {` |
| POST | `/contact` | [src/support/extension.js:128](../../src/support/extension.js#L128) | `, route(async (req, s, scope) => {` |
| POST | `/contacts` | [src/support/devices.js:165](../../src/support/devices.js#L165) | `, route(async (req, s) => {` |
| POST | `/contacts` | [src/support/extension.js:136](../../src/support/extension.js#L136) | `, route(async (req, s, scope) => {` |
| POST | `/control/release` | [app_asisto_ws.js:775](../../app_asisto_ws.js#L775) | `, requireStatusToken, async (req, res) => {` |
| POST | `/drafts/:id/acknowledge-source` | [src/support/routes.js:65](../../src/support/routes.js#L65) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/approve` | [src/support/routes.js:64](../../src/support/routes.js#L64) | `, route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, {}, true)));` |
| POST | `/drafts/:id/discard-changes` | [src/support/extension.js:215](../../src/support/extension.js#L215) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/dismiss` | [src/support/extension.js:207](../../src/support/extension.js#L207) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/mail` | [src/support/extension.js:52](../../src/support/extension.js#L52) | `, route(async (req,s,scope) => { const row = await rowFor(s,scope,req.params.id); return mailFactory(s).send(s` |
| POST | `/drafts/:id/manual-complete` | [src/support/extension.js:195](../../src/support/extension.js#L195) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/publish` | [src/support/extension.js:282](../../src/support/extension.js#L282) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/queue` | [src/support/extension.js:184](../../src/support/extension.js#L184) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/reconcile` | [src/support/extension.js:163](../../src/support/extension.js#L163) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/save` | [src/support/extension.js:162](../../src/support/extension.js#L162) | `, route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, req.body.fields)));` |
| POST | `/heartbeat` | [src/support/devices.js:108](../../src/support/devices.js#L108) | `, route(async (req, s) => {` |
| POST | `/history` | [src/support/routes.js:59](../../src/support/routes.js#L59) | `, route((req, s, scope) => s.history(scope, req.body.from, req.body.to)));` |
| POST | `/hubspot/connect` | [src/support/extension.js:236](../../src/support/extension.js#L236) | `, route(async (req, s, scope) => {` |
| POST | `/login` | [auth_ui.js:3515](../../auth_ui.js#L3515) | `, async (req, res) => {` |
| POST | `/logout` | [auth_ui.js:3599](../../auth_ui.js#L3599) | `, (req, res) => {` |
| POST | `/mail/settings` | [src/support/extension.js:49](../../src/support/extension.js#L49) | `, route(async (req,s,scope) => mailFactory(s).save(scope,req.body)));` |
| POST | `/mail/verify` | [src/support/extension.js:50](../../src/support/extension.js#L50) | `, route(async (req,s,scope) => mailFactory(s).verify(scope)));` |
| POST | `/messages/assign` | [src/support/extension.js:107](../../src/support/extension.js#L107) | `, route((req, s, scope) => s.assignMessages(scope, req.body)));` |
| POST | `/messages` | [src/support/devices.js:153](../../src/support/devices.js#L153) | `, route(async (req, s) => {` |
| POST | `/poll` | [src/support/devices.js:79](../../src/support/devices.js#L79) | `, route(async (req, s) => {` |
| POST | `/revoke` | [src/support/devices.js:101](../../src/support/devices.js#L101) | `, route(async (req, s) => {` |
| POST | `/session` | [src/support/devices.js:123](../../src/support/devices.js#L123) | `, route(async (req, s) => {` |
| POST | `/session` | [src/support/routes.js:52](../../src/support/routes.js#L52) | `, route(async (req, s, scope) => {` |
| POST | `/start` | [src/support/devices.js:65](../../src/support/devices.js#L65) | `, route(async (req, s) => {` |
| POST | `/v200/api/Api_Chat_Cab/ProcesarMensajePost` | [endpoint.js:10679](../../endpoint.js#L10679) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/webhook` | [endpoint.js:12508](../../endpoint.js#L12508) | `, handleWebhookPost);` |
| POST | `/webhook` | [src/whatsapp/webhook.routes.js:76](../../src/whatsapp/webhook.routes.js#L76) | `, async (req, res) => {` |
| POST | `/webhooks/mercadopago/subscriptions` | [billing_subscriptions.js:120](../../billing_subscriptions.js#L120) | `, express.json({ limit: '16kb' }), async (req, res) => {` |
| POST | `/work` | [src/support/devices.js:178](../../src/support/devices.js#L178) | `, route(async (req, s) => {` |
| PUT | `/api/billing/accounts/:owner` | [billing_subscriptions.js:96](../../billing_subscriptions.js#L96) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| PUT | `/api/customer-app-admin/:tenant/sellers` | [customer_queue.js:134](../../customer_queue.js#L134) | `, wrap(async (req, res) => {` |
| PUT | `/api/fleteros/viajes/:id` | [fleteros_viajes_panel.js:2965](../../fleteros_viajes_panel.js#L2965) | `, requireAuth, async (req, res) => {` |
| PUT | `/api/monetization/config` | [monetization_config.js:49](../../monetization_config.js#L49) | `,auth.requireAuth,requireSuper,async(req,res)=>{const tenantId=tenant(req.body?.tenantId);if(!tenantId)return ` |
| PUT | `/api/products/:id` | [endpoint.js:7739](../../endpoint.js#L7739) | `, async (req, res) => {` |
| PUT | `/api/products/:id` | [src/web/web_admin.routes.js:80](../../src/web/web_admin.routes.js#L80) | `, async (req, res) => {` |
| PUT | `/api/resto/settings` | [restaurant_operations.js:169](../../restaurant_operations.js#L169) | `, (_req,res)=>res.status(410).json({ error:'Configurá estas variables en Configuración de dominio.' }));` |
| PUT | `/hubspot` | [src/support/routes.js:84](../../src/support/routes.js#L84) | `, route(async () => { requireHubSpot(); fail('hubspot_backend_managed', 410); }));` |
| PUT | `/memory/verify` | [src/support/routes.js:76](../../src/support/routes.js#L76) | `, route(async (req, s, scope) => {` |
| PUT | `/memory` | [src/support/routes.js:75](../../src/support/routes.js#L75) | `, route((req, s, scope) => s.rememberContact(scope, req.body)));` |
| PUT | `/settings` | [src/support/routes.js:45](../../src/support/routes.js#L45) | `, route((req, s, scope) => s.saveConfig(scope, req.body)));` |
| PUT | `/tenant-settings` | [src/support/routes.js:46](../../src/support/routes.js#L46) | `, route((req, s, scope) => { admin(req); return s.saveConfig({ ...scope, userId: '*' }, req.body); }));` |
| USE | `/api/customer-app-admin` | [customer_app_web.js:111](../../customer_app_web.js#L111) | `, express.json({ limit: "32kb" }));` |
| USE | `/api/customer-app` | [customer_app_web.js:110](../../customer_app_web.js#L110) | `, express.json({ limit: "32kb" }));` |
| USE | `/api/support/device` | [src/support/routes.js:120](../../src/support/routes.js#L120) | `, createDeviceRouter({ getService, publicOrigin }));` |
| USE | `/api/support/extension` | [src/support/routes.js:121](../../src/support/routes.js#L121) | `, createExtensionRouter({ getService }));` |
| USE | `/api/support` | [src/support/routes.js:122](../../src/support/routes.js#L122) | `, createRouter({ getService, publicOrigin }));` |
| USE | `/api/support` | [src/support/routes.js:124](../../src/support/routes.js#L124) | `, (req, res) => {` |
| USE | `/api/wweb` | [endpoint.js:485](../../endpoint.js#L485) | `, auth.requireWwebAccess);` |
| USE | `/customer-app/assets` | [customer_app_web.js:112](../../customer_app_web.js#L112) | `, express.static(require('path').join(__dirname, 'static', 'turnero')));` |
| USE | `/static/clientes` | [endpoint.js:151](../../endpoint.js#L151) | `, express.static(path.join(__dirname, "static", "clientes")));` |
| USE | `/static` | [endpoint.js:154](../../endpoint.js#L154) | `, express.static(path.join(__dirname, "static")));` |
| USE | `/static` | [endpoint.js:157](../../endpoint.js#L157) | `, express.static(path.join(__dirname)));` |
| USE | `/ui` | [endpoint.js:169](../../endpoint.js#L169) | `, auth.requireAuth);` |
