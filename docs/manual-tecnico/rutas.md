# Inventario generado desde el código

Regenerar: `node scripts/build_technical_manual.cjs`. No contiene valores de producción.

## Rutas HTTP detectadas

Este índice estático no es un contrato OpenAPI: incluye rutas internas, posibles registros no montados y prefijos parciales. La columna final es un fragmento literal posterior a la ruta, no una certificación de autenticación. Verificar el montaje y el handler enlazado antes de integrar. No detecta todas las rutas construidas dinámicamente ni arrays de aliases.

| Método | Ruta declarada | Implementación | Inicio de registro / middleware |
|---|---|---|---|
| DELETE | `/api/leads/:id` | [auth_ui.js:3509](../../auth_ui.js#L3509) | `, requireAuth, requireAdmin, async (req, res) => {` |
| DELETE | `/api/leads/:id` | [auth_ui.js:5450](../../auth_ui.js#L5450) | `, requireAuth, requireAdmin, async (req, res) => {` |
| DELETE | `/api/products/:id` | [endpoint.js:7916](../../endpoint.js#L7916) | `, async (req, res) => {` |
| DELETE | `/api/products/:id` | [src/web/web_admin.routes.js:123](../../src/web/web_admin.routes.js#L123) | `, async (req, res) => {` |
| DELETE | `/api/tenant-channels/:id` | [endpoint.js:456](../../endpoint.js#L456) | `, auth.requireAdmin, async (req, res) => {` |
| DELETE | `/api/tenant-config` | [auth_ui.js:5222](../../auth_ui.js#L5222) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/.well-known/assetlinks.json` | [customer_app_web.js:139](../../customer_app_web.js#L139) | `, (_req, res) => res.sendFile(require('path').join(__dirname, 'static/turnero/assetlinks.json')));` |
| GET | `/` | [app_asisto_ws.js:529](../../app_asisto_ws.js#L529) | `, (req, res) => {` |
| GET | `/` | [endpoint.js:1887](../../endpoint.js#L1887) | `, async (req, res) => {` |
| GET | `/admin/billing` | [billing_subscriptions.js:84](../../billing_subscriptions.js#L84) | `, auth.requireAuth, requireSuper, (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(render` |
| GET | `/admin/bot-test` | [bot_test_panel.js:238](../../bot_test_panel.js#L238) | `, async (req, res) => {` |
| GET | `/admin/client-phone-access` | [client_phone_access.js:389](../../client_phone_access.js#L389) | `, requireAdmin, async (req, res) => {` |
| GET | `/admin/conversation` | [endpoint.js:7236](../../endpoint.js#L7236) | `, async (req, res) => {` |
| GET | `/admin/fleteros/viajes` | [fleteros_viajes_panel.js:2639](../../fleteros_viajes_panel.js#L2639) | `, requireAuth, async (req, res) => {` |
| GET | `/admin/followup` | [conversation_followup_panel.js:1055](../../conversation_followup_panel.js#L1055) | `, async (req, res) => {` |
| GET | `/admin/help-stats` | [help_stats.js:6](../../help_stats.js#L6) | `,...access,(req,res)=>req.query.embed==='1'?res.type('html').send(page()):res.redirect('/ui/help_stats'));` |
| GET | `/admin/inbox` | [endpoint.js:4129](../../endpoint.js#L4129) | `, async (req, res) => {` |
| GET | `/admin/inbox` | [wa_inbox_panel.js:974](../../wa_inbox_panel.js#L974) | `, async (req, res) => {` |
| GET | `/admin/leads` | [auth_ui.js:5316](../../auth_ui.js#L5316) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/messages/:convId` | [endpoint.js:7512](../../endpoint.js#L7512) | `, async (req, res) => {` |
| GET | `/admin/monetization` | [monetization_config.js:45](../../monetization_config.js#L45) | `,auth.requireAuth,requireSuper,(_req,res)=>res.type('html').send(renderPage()));` |
| GET | `/admin/order-config` | [order_config_panel.js:309](../../order_config_panel.js#L309) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/admin/resto` | [restaurant.js:284](../../restaurant.js#L284) | `, (_req, res) => res.sendFile(path.join(__dirname, 'static', 'restaurant_panel.html')));` |
| GET | `/admin/support` | [src/support/routes.js:128](../../src/support/routes.js#L128) | `, (req, res) => {` |
| GET | `/admin/telegram` | [telegram_runtime.js:2255](../../telegram_runtime.js#L2255) | `, auth.requireAuth, auth.requireAdmin, async (_req, res) => {` |
| GET | `/admin/tenant-config` | [auth_ui.js:5012](../../auth_ui.js#L5012) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/ticket/:convId` | [endpoint.js:7548](../../endpoint.js#L7548) | `, async (req, res) => {` |
| GET | `/admin/token-control` | [token_control_stats.js:2699](../../token_control_stats.js#L2699) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/admin/users` | [auth_ui.js:3741](../../auth_ui.js#L3741) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/web-access` | [web_access_stats.js:508](../../web_access_stats.js#L508) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/admin/wweb` | [auth_ui.js:5467](../../auth_ui.js#L5467) | `, requireAuth, (req, res, next) => hasAccess(req.user, 'wweb', 'support') ? next() : res.status(403).send('403` |
| GET | `/admin` | [endpoint.js:5309](../../endpoint.js#L5309) | `, async (req, res) => {` |
| GET | `/api/admin/conversation-meta` | [endpoint.js:4078](../../endpoint.js#L4078) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/conversations` | [wa_inbox_panel.js:989](../../wa_inbox_panel.js#L989) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/media/:msgId` | [wa_inbox_panel.js:1201](../../wa_inbox_panel.js#L1201) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/messages` | [wa_inbox_panel.js:1038](../../wa_inbox_panel.js#L1038) | `, async (req, res) => {` |
| GET | `/api/admin/wa-inbox/meta` | [wa_inbox_panel.js:1000](../../wa_inbox_panel.js#L1000) | `, async (req, res) => {` |
| GET | `/api/behavior` | [endpoint.js:9806](../../endpoint.js#L9806) | `, async (req, res) => {` |
| GET | `/api/behavior` | [src/web/web_admin.routes.js:416](../../src/web/web_admin.routes.js#L416) | `, async (req, res) => {` |
| GET | `/api/billing/accounts` | [billing_subscriptions.js:85](../../billing_subscriptions.js#L85) | `, auth.requireAuth, requireSuper, wrap(async (_req, res) => {` |
| GET | `/api/client-phone-access` | [client_phone_access.js:401](../../client_phone_access.js#L401) | `, requireAdmin, async (req, res) => {` |
| GET | `/api/conversation-followup/:id/history` | [conversation_followup_panel.js:1334](../../conversation_followup_panel.js#L1334) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/:id/messages` | [conversation_followup_panel.js:1318](../../conversation_followup_panel.js#L1318) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/:id` | [conversation_followup_panel.js:1358](../../conversation_followup_panel.js#L1358) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/api-message-window/:id` | [conversation_followup_panel.js:1285](../../conversation_followup_panel.js#L1285) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/api-message-windows` | [conversation_followup_panel.js:1230](../../conversation_followup_panel.js#L1230) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/config` | [conversation_followup_panel.js:1092](../../conversation_followup_panel.js#L1092) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/conversations` | [conversation_followup_panel.js:1118](../../conversation_followup_panel.js#L1118) | `, async (req, res) => {` |
| GET | `/api/conversation-followup/pilot-sessions/:id` | [conversation_followup_panel.js:1081](../../conversation_followup_panel.js#L1081) | `, async(req,res)=>{` |
| GET | `/api/conversation-followup/pilot-sessions` | [conversation_followup_panel.js:1075](../../conversation_followup_panel.js#L1075) | `, async(req,res)=>{` |
| GET | `/api/conversation-followup/version` | [conversation_followup_panel.js:1088](../../conversation_followup_panel.js#L1088) | `, (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/presence/:sessionId/status` | [customer_queue.js:179](../../customer_queue.js#L179) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/presence` | [customer_queue.js:150](../../customer_queue.js#L150) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/printer/status` | [customer_queue.js:272](../../customer_queue.js#L272) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/product-stats` | [product_insights_routes.js:9](../../product_insights_routes.js#L9) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/sellers` | [customer_queue.js:130](../../customer_queue.js#L130) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/state` | [customer_queue.js:220](../../customer_queue.js#L220) | `, state);` |
| GET | `/api/customer-app-admin/:tenant/stats` | [queue_stats.js:108](../../queue_stats.js#L108) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app-admin/:tenant/tickets/:id/delivery` | [customer_queue.js:252](../../customer_queue.js#L252) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app/:tenant/config` | [customer_app_web.js:142](../../customer_app_web.js#L142) | `, async (req, res) => { try { const t=tenant(req.params.tenant),{ sellers: _privateSellers, ...publicConfig }=` |
| GET | `/api/customer-app/:tenant/presence/:sessionId/status` | [customer_queue.js:173](../../customer_queue.js#L173) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-app/:tenant/queue` | [customer_queue.js:219](../../customer_queue.js#L219) | `, state);` |
| GET | `/api/customer-app/:tenant/tickets/:id` | [customer_queue.js:350](../../customer_queue.js#L350) | `, wrap(async (req, res) => {` |
| GET | `/api/customer-notifications/:tenant/center/devices/:id` | [app_center.js:40](../../app_center.js#L40) | `,guard,access,wrap(async(req,res)=>{` |
| GET | `/api/customer-notifications/:tenant/center/summary` | [app_activity_summary.js:5](../../app_activity_summary.js#L5) | `,guard,access,wrap(async(req,res)=>{` |
| GET | `/api/customer-notifications/:tenant/center` | [app_center.js:29](../../app_center.js#L29) | `,guard,access,wrap(async(req,res)=>{` |
| GET | `/api/customer-notifications/:tenant` | [customer_notifications.js:15](../../customer_notifications.js#L15) | `,requireAuth,async(req,res)=>{try{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,t))return res` |
| GET | `/api/customer-notifications/:tenant` | [deploy/patch-notification-devices.cjs:7](../../deploy/patch-notification-devices.cjs#L7) | `,", "app.post('/api/customer-notifications/:tenant',",'async function firebaseSender(){']){` |
| GET | `/api/ext/ayuda/playlists/:id` | [help_playlists.js:81](../../help_playlists.js#L81) | `, requireAccess, (req, res) => handle(req, res, false));` |
| GET | `/api/ext/ayuda/playlists` | [help_playlists.js:80](../../help_playlists.js#L80) | `, requireAccess, (req, res) => handle(req, res, false));` |
| GET | `/api/ext/ayuda` | [help_tool.js:2328](../../help_tool.js#L2328) | `, requireHelpExternalAccess, handleHelpQuery);` |
| GET | `/api/ext/domain-status` | [endpoint.js:1514](../../endpoint.js#L1514) | `, requireDomainStatusAccess, async (req, res) => {` |
| GET | `/api/ext/help/playlists/:id` | [help_playlists.js:84](../../help_playlists.js#L84) | `, requireAccess, (req, res) => handle(req, res, false));` |
| GET | `/api/ext/help/playlists` | [help_playlists.js:83](../../help_playlists.js#L83) | `, requireAccess, (req, res) => handle(req, res, false));` |
| GET | `/api/ext/help/status` | [help_tool.js:2332](../../help_tool.js#L2332) | `, requireHelpExternalAccess, async (req, res) => {` |
| GET | `/api/ext/help` | [help_tool.js:2326](../../help_tool.js#L2326) | `, requireHelpExternalAccess, handleHelpQuery);` |
| GET | `/api/ext/qr/alternatives` | [qr_product_web.js:1617](../../qr_product_web.js#L1617) | `, async (req, res) => {` |
| GET | `/api/ext/qr/chat/messages` | [qr_product_web.js:1651](../../qr_product_web.js#L1651) | `, async (req, res) => {` |
| GET | `/api/ext/qr/product` | [qr_product_web.js:1569](../../qr_product_web.js#L1569) | `, async (req, res) => {` |
| GET | `/api/ext/qr/scanner-assets/:asset` | [qr_local_scanner.js:131](../../qr_local_scanner.js#L131) | `, (req, res) => {` |
| GET | `/api/ext/wweb/qr-image` | [endpoint.js:1672](../../endpoint.js#L1672) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/ext/wweb/qr` | [endpoint.js:1614](../../endpoint.js#L1614) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/ext/wweb/status` | [endpoint.js:1465](../../endpoint.js#L1465) | `, requireWwebExternalAccess, async (req, res) => {` |
| GET | `/api/fleteros/api-config` | [fleteros_viajes_panel.js:2710](../../fleteros_viajes_panel.js#L2710) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/search` | [fleteros_viajes_panel.js:2654](../../fleteros_viajes_panel.js#L2654) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/status` | [fleteros_viajes_panel.js:2684](../../fleteros_viajes_panel.js#L2684) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/viajes/:id` | [fleteros_viajes_panel.js:2950](../../fleteros_viajes_panel.js#L2950) | `, requireAuth, async (req, res) => {` |
| GET | `/api/fleteros/viajes` | [fleteros_viajes_panel.js:2928](../../fleteros_viajes_panel.js#L2928) | `, requireAuth, async (req, res) => {` |
| GET | `/api/help-stats` | [help_stats.js:7](../../help_stats.js#L7) | `,...access,async(req,res)=>{try{` |
| GET | `/api/hours` | [endpoint.js:10328](../../endpoint.js#L10328) | `, async (req, res) => {` |
| GET | `/api/hours` | [src/web/web_admin.routes.js:494](../../src/web/web_admin.routes.js#L494) | `, async (req, res) => {` |
| GET | `/api/leads/:id` | [auth_ui.js:3490](../../auth_ui.js#L3490) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads/:id` | [auth_ui.js:5434](../../auth_ui.js#L5434) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads` | [auth_ui.js:3455](../../auth_ui.js#L3455) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/leads` | [auth_ui.js:5421](../../auth_ui.js#L5421) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/logs/conversations` | [endpoint.js:3769](../../endpoint.js#L3769) | `, async (req, res) => {` |
| GET | `/api/logs/messages` | [endpoint.js:4049](../../endpoint.js#L4049) | `, async (req, res) => {` |
| GET | `/api/logs/pedido` | [endpoint.js:5187](../../endpoint.js#L5187) | `, async (req, res) => {` |
| GET | `/api/media/:msgId` | [endpoint.js:3914](../../endpoint.js#L3914) | `, async (req, res) => {` |
| GET | `/api/monetization/config` | [monetization_config.js:47](../../monetization_config.js#L47) | `,auth.requireAuth,requireSuper,async(req,res)=>{const tenantId=tenant(req.query.tenantId);if(!tenantId)return ` |
| GET | `/api/monetization/summary` | [monetization_config.js:48](../../monetization_config.js#L48) | `,auth.requireAuth,async(req,res)=>{try{const {buildMonetizationSummary}=require('./monetization_engine'),isSup` |
| GET | `/api/monetization/tenants` | [monetization_config.js:46](../../monetization_config.js#L46) | `,auth.requireAuth,requireSuper,async(req,res)=>{const current=tenant(req.user?.tenantId),tenants=await listMon` |
| GET | `/api/operations-dashboard/tenants` | [operations_dashboard.js:265](../../operations_dashboard.js#L265) | `, requireAuth, async (req, res) => {` |
| GET | `/api/operations-dashboard` | [operations_dashboard.js:253](../../operations_dashboard.js#L253) | `, requireAuth, async (req, res) => {` |
| GET | `/api/order-config/current` | [order_config_panel.js:325](../../order_config_panel.js#L325) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/order-config/defaults` | [order_config_panel.js:320](../../order_config_panel.js#L320) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/products/domains` | [endpoint.js:7689](../../endpoint.js#L7689) | `, async (req, res) => {` |
| GET | `/api/products` | [endpoint.js:7698](../../endpoint.js#L7698) | `, async (req, res) => {` |
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
| GET | `/api/tenant-channels` | [endpoint.js:360](../../endpoint.js#L360) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-channels` | [src/web/tenant_channels.routes.js:15](../../src/web/tenant_channels.routes.js#L15) | `, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-config/whatsapp-metrics` | [auth_ui.js:5064](../../auth_ui.js#L5064) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/tenant-config` | [auth_ui.js:5100](../../auth_ui.js#L5100) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/tg/chats` | [telegram_runtime.js:2310](../../telegram_runtime.js#L2310) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tg/stats` | [telegram_runtime.js:2295](../../telegram_runtime.js#L2295) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/tg/status` | [telegram_runtime.js:2263](../../telegram_runtime.js#L2263) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| GET | `/api/token-control/api-message-windows` | [token_control_stats.js:2801](../../token_control_stats.js#L2801) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/conversations` | [token_control_stats.js:2776](../../token_control_stats.js#L2776) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/exchange-rate` | [token_control_stats.js:2743](../../token_control_stats.js#L2743) | `, requireAuth, requireTokenControlAccess, async (_req, res) => {` |
| GET | `/api/token-control/media/:id/content` | [token_control_media.js:65](../../token_control_media.js#L65) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| GET | `/api/token-control/media/:id` | [token_control_media.js:60](../../token_control_media.js#L60) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| GET | `/api/token-control/summary` | [token_control_stats.js:2720](../../token_control_stats.js#L2720) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/token-control/timeline` | [token_control_stats.js:2754](../../token_control_stats.js#L2754) | `, requireAuth, requireTokenControlAccess, async (req, res) => {` |
| GET | `/api/web-access/summary` | [web_access_stats.js:517](../../web_access_stats.js#L517) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/api/wweb/history` | [auth_ui.js:6217](../../auth_ui.js#L6217) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/history` | [endpoint.js:1819](../../endpoint.js#L1819) | `, async (req, res) => {` |
| GET | `/api/wweb/locks` | [auth_ui.js:5710](../../auth_ui.js#L5710) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/qr` | [auth_ui.js:5805](../../auth_ui.js#L5805) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| GET | `/api/wweb/sessions` | [endpoint.js:1402](../../endpoint.js#L1402) | `, async (req, res) => {` |
| GET | `/api/wweb/stats` | [auth_ui.js:6087](../../auth_ui.js#L6087) | `, requireAuth, requireAdmin, async (req, res) => {` |
| GET | `/app` | [auth_ui.js:3615](../../auth_ui.js#L3615) | `, requireAuth, (req, res) => {` |
| GET | `/audit` | [src/support/routes.js:73](../../src/support/routes.js#L73) | `, route((req, s, scope) => s.col('audit').find(scope).sort({ at: -1 }).limit(100).toArray()));` |
| GET | `/cache/audio/:id` | [endpoint.js:2405](../../endpoint.js#L2405) | `, (req, res) => {` |
| GET | `/cache/media/:id` | [endpoint.js:2411](../../endpoint.js#L2411) | `, (req, res) => {` |
| GET | `/canales` | [endpoint.js:9426](../../endpoint.js#L9426) | `, async (req, res) => {` |
| GET | `/capabilities` | [src/support/routes.js:43](../../src/support/routes.js#L43) | `, (req, res) => res.json({ hubspotEnabled, ...req.supportScope }));` |
| GET | `/comportamiento-ui.js` | [endpoint.js:8916](../../endpoint.js#L8916) | `, (_req, res) => {` |
| GET | `/comportamiento` | [endpoint.js:9250](../../endpoint.js#L9250) | `, async (req, res) => {` |
| GET | `/comportamiento` | [src/web/web_admin.routes.js:360](../../src/web/web_admin.routes.js#L360) | `, async (req, res) => {` |
| GET | `/contact-control` | [src/support/extension.js:121](../../src/support/extension.js#L121) | `, route(async (req, s, scope) => {` |
| GET | `/customer-app/:tenant/` | [customer_queue.js:114](../../customer_queue.js#L114) | ` + mode, wrap(async (req, res) => {` |
| GET | `/customer-app/:tenant` | [customer_app_web.js:141](../../customer_app_web.js#L141) | `, (req, res) => { const t = tenant(req.params.tenant); if (!t) return res.status(400).send("Dominio inválido")` |
| GET | `/customer-app/MCN/account` | [mecan_accounts.js:47](../../mecan_accounts.js#L47) | `,(req,res)=>{if(req.hostname!=='asistobot.com.ar')return res.redirect(origin+'/customer-app/MCN/account');res.` |
| GET | `/customer-app/download/android` | [customer_app_web.js:140](../../customer_app_web.js#L140) | `, (_req, res) => res.download(require('path').join(__dirname, 'Asisto-1.1.7.apk'), 'Asisto-1.1.7.apk'));` |
| GET | `/drafts/:id/evidence` | [src/support/routes.js:62](../../src/support/routes.js#L62) | `, route((req, s, scope) => s.evidence(scope, req.params.id)));` |
| GET | `/drafts/:id/mail` | [src/support/extension.js:64](../../src/support/extension.js#L64) | `, route(async (req,s,scope) => { const row = await rowFor(s,scope,req.params.id); return mailFactory(s).histor` |
| GET | `/drafts/:id` | [src/support/extension.js:162](../../src/support/extension.js#L162) | `, route(async (req, s, scope) => {` |
| GET | `/drafts` | [src/support/extension.js:95](../../src/support/extension.js#L95) | `, route(async (req, s, scope) => {` |
| GET | `/drafts` | [src/support/routes.js:61](../../src/support/routes.js#L61) | `, route((req, s, scope) => s.listDrafts(scope, req.query.before, req.query.view &#124;&#124; 'tasks')));` |
| GET | `/favicon.ico` | [endpoint.js:159](../../endpoint.js#L159) | `, (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "static", "favicon-asisto.` |
| GET | `/healthz` | [endpoint.js:2394](../../endpoint.js#L2394) | `, (_req, res) => res.json({ ok: true }));` |
| GET | `/healthz` | [turnero_server.js:29](../../turnero_server.js#L29) | `, async (_req, res) => {` |
| GET | `/history/status` | [src/support/routes.js:60](../../src/support/routes.js#L60) | `, route((req, s, scope) => s.historyStatus(scope, req.query.from, req.query.to)));` |
| GET | `/horarios` | [endpoint.js:8531](../../endpoint.js#L8531) | `, async (req, res) => {` |
| GET | `/horarios` | [src/web/web_admin.routes.js:233](../../src/web/web_admin.routes.js#L233) | `, async (req, res) => {` |
| GET | `/hubspot/companies/:id/tickets` | [src/support/routes.js:86](../../src/support/routes.js#L86) | `, route(async (req, s, scope) => (await client(s, scope)).companyTickets(req.params.id)));` |
| GET | `/hubspot/company-contacts` | [src/support/extension.js:318](../../src/support/extension.js#L318) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/company` | [src/support/extension.js:324](../../src/support/extension.js#L324) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/mail-contacts` | [src/support/extension.js:297](../../src/support/extension.js#L297) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot/metadata` | [src/support/routes.js:85](../../src/support/routes.js#L85) | `, route(async (req, s, scope) => (await client(s, scope)).metadata()));` |
| GET | `/hubspot/search` | [src/support/extension.js:313](../../src/support/extension.js#L313) | `, route(async (req, s, scope) => {` |
| GET | `/hubspot` | [src/support/extension.js:286](../../src/support/extension.js#L286) | `, route(async (req, s, scope) => {` |
| GET | `/index` | [src/support/extension.js:80](../../src/support/extension.js#L80) | `, route(async (req, s, scope) => {` |
| GET | `/jobs` | [src/support/routes.js:71](../../src/support/routes.js#L71) | `, route((req, s, scope) => s.col('jobs').find(scope, { projection: { claim: 0 } }).sort({ createdAt: -1 }).lim` |
| GET | `/login` | [auth_ui.js:3399](../../auth_ui.js#L3399) | `, (req, res) => {` |
| GET | `/mail/settings` | [src/support/extension.js:61](../../src/support/extension.js#L61) | `, route(async (req,s,scope) => mailFactory(s).view(scope)));` |
| GET | `/memory` | [src/support/routes.js:74](../../src/support/routes.js#L74) | `, route((req, s, scope) => s.col('memory').find(scope).limit(500).toArray()));` |
| GET | `/messages` | [src/support/extension.js:102](../../src/support/extension.js#L102) | `, route(async (req, s, scope) => {` |
| GET | `/novedades` | [endpoint.js:1896](../../endpoint.js#L1896) | `, (_req, res) => {` |
| GET | `/productos` | [endpoint.js:7967](../../endpoint.js#L7967) | `, async (req, res) => {` |
| GET | `/productos` | [src/web/web_admin.routes.js:174](../../src/web/web_admin.routes.js#L174) | `, async (req, res) => {` |
| GET | `/qr/:tenant/:codigo` | [qr_product_web.js:1518](../../qr_product_web.js#L1518) | `, async (req, res) => {` |
| GET | `/qr/:tenant` | [qr_product_web.js:1501](../../qr_product_web.js#L1501) | `, async (req, res) => {` |
| GET | `/r` | [web_access_stats.js:501](../../web_access_stats.js#L501) | `, async (req, res) => {` |
| GET | `/request/:code` | [src/support/devices.js:83](../../src/support/devices.js#L83) | `, route(async (req, s) => {` |
| GET | `/resto/:tenant/:token` | [restaurant.js:86](../../restaurant.js#L86) | `, async (req, res) => {` |
| GET | `/resto/image/:id` | [restaurant_image.js:27](../../restaurant_image.js#L27) | `, async (req, res) => {` |
| GET | `/robots.txt` | [auth_ui.js:3570](../../auth_ui.js#L3570) | `, (req, res) => {` |
| GET | `/robots.txt` | [endpoint.js:2368](../../endpoint.js#L2368) | `, (_req, res) => {` |
| GET | `/session` | [src/support/extension.js:76](../../src/support/extension.js#L76) | `, route(async (req, s, scope) => {` |
| GET | `/session` | [src/support/routes.js:47](../../src/support/routes.js#L47) | `, route(async (req, s, scope) => {` |
| GET | `/settings` | [src/support/routes.js:44](../../src/support/routes.js#L44) | `, route((req, s, scope) => s.config(scope)));` |
| GET | `/sitemap.xml` | [auth_ui.js:3592](../../auth_ui.js#L3592) | `, (req, res) => {` |
| GET | `/sitemap.xml` | [endpoint.js:2378](../../endpoint.js#L2378) | `, (_req, res) => {` |
| GET | `/static/app-activity-chart.js` | [app_activity_summary.js:4](../../app_activity_summary.js#L4) | `,guard,(_q,r)=>r.type('js').sendFile(require('path').join(__dirname,'app_activity_chart.js')));` |
| GET | `/static/app-center-client.js` | [app_center.js:76](../../app_center.js#L76) | `,(_req,res)=>res.type('js').sendFile(require('path').join(__dirname,'app_center_client.js')));` |
| GET | `/static/app-center-panel.js` | [app_center.js:77](../../app_center.js#L77) | `,guard,(_req,res)=>res.type('js').sendFile(require('path').join(__dirname,'app_center_panel.js')));` |
| GET | `/static/mecan-account-nav.js` | [app_center.js:20](../../app_center.js#L20) | `,(_q,res)=>res.type('js').sendFile(require('path').join(__dirname,'mecan_account_nav.js')));` |
| GET | `/status/lock` | [app_asisto_ws.js:752](../../app_asisto_ws.js#L752) | `, requireStatusToken, async (req, res) => {` |
| GET | `/status/qr` | [app_asisto_ws.js:757](../../app_asisto_ws.js#L757) | `, requireStatusToken, async (req, res) => {` |
| GET | `/status` | [app_asisto_ws.js:732](../../app_asisto_ws.js#L732) | `, requireStatusToken, async (req, res) => {` |
| GET | `/ui/:page` | [auth_ui.js:3667](../../auth_ui.js#L3667) | `, requireAuth, (req, res) => {` |
| GET | `/ui/configuracion` | [auth_ui.js:3659](../../auth_ui.js#L3659) | `, requireAuth, (req, res) => {` |
| GET | `/ui/notificaciones-app` | [customer_notifications.js:14](../../customer_notifications.js#L14) | `,requireAuth,async(req,res)=>{const isSuper=String(req.user?.role&#124;&#124;'').toLowerCase()==='superadmin',` |
| GET | `/ui/turnero/:tenant/estadisticas` | [queue_stats.js:97](../../queue_stats.js#L97) | `, wrap(async (req, res) => {` |
| GET | `/ui/turnero/:tenant/vendedores` | [customer_queue.js:125](../../customer_queue.js#L125) | `, wrap(async (req, res) => {` |
| GET | `/ui/turnero/:tenant` | [customer_queue.js:119](../../customer_queue.js#L119) | `, wrap(async (req, res) => {` |
| GET | `/usage` | [src/support/routes.js:72](../../src/support/routes.js#L72) | `, route((req, s, scope) => s.col('usage').find(scope).sort({ at: -1 }).limit(100).toArray()));` |
| GET | `/webhook` | [endpoint.js:10741](../../endpoint.js#L10741) | `, async (req, res) => {` |
| GET | `/webhook` | [src/whatsapp/webhook.routes.js:52](../../src/whatsapp/webhook.routes.js#L52) | `, async (req, res) => {` |
| GET | `/webhooks/mercadopago/subscriptions/return` | [billing_subscriptions.js:119](../../billing_subscriptions.js#L119) | `, (_req, res) => res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Asisto · M` |
| GET | `/whatsapp/session` | [src/support/extension.js:53](../../src/support/extension.js#L53) | `, route((req, s, scope) => whatsappSession(s, scope)));` |
| PATCH | `/api/customer-notifications/:tenant/center/devices/:id` | [app_center.js:45](../../app_center.js#L45) | `,guard,access,json,wrap(async(req,res)=>{` |
| PATCH | `/api/customer-notifications/:tenant/devices/:installId` | [customer_notifications.js:16](../../customer_notifications.js#L16) | `,requireAuth,notificationJson,async(req,res)=>{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,` |
| PATCH | `/api/resto/events/:id` | [restaurant.js:265](../../restaurant.js#L265) | `, json, async (req, res) => {` |
| PATCH | `/drafts/:id` | [src/support/routes.js:63](../../src/support/routes.js#L63) | `, route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, req.body.fields)));` |
| POST | `/admin/leads/delete` | [auth_ui.js:5406](../../auth_ui.js#L5406) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/create` | [auth_ui.js:3764](../../auth_ui.js#L3764) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/delete` | [auth_ui.js:3930](../../auth_ui.js#L3930) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/reset-password` | [auth_ui.js:3891](../../auth_ui.js#L3891) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/admin/users/update` | [auth_ui.js:3821](../../auth_ui.js#L3821) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api-chat-cab/procesar-mensaje` | [endpoint.js:10683](../../endpoint.js#L10683) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/api/admin/conversation-delivered` | [endpoint.js:4923](../../endpoint.js#L4923) | `, async (req, res) => {` |
| POST | `/api/admin/conversation-kitchen` | [endpoint.js:4972](../../endpoint.js#L4972) | `, async (req, res) => {` |
| POST | `/api/admin/conversation-manual` | [endpoint.js:5021](../../endpoint.js#L5021) | `, async (req, res) => {` |
| POST | `/api/admin/send-message` | [endpoint.js:5064](../../endpoint.js#L5064) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/finalize` | [wa_inbox_panel.js:1093](../../wa_inbox_panel.js#L1093) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/manual` | [wa_inbox_panel.js:1063](../../wa_inbox_panel.js#L1063) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/send-file` | [wa_inbox_panel.js:1159](../../wa_inbox_panel.js#L1159) | `, async (req, res) => {` |
| POST | `/api/admin/wa-inbox/send-message` | [wa_inbox_panel.js:1134](../../wa_inbox_panel.js#L1134) | `, async (req, res) => {` |
| POST | `/api/behavior/refresh-cache` | [endpoint.js:10131](../../endpoint.js#L10131) | `, async (req, res) => {` |
| POST | `/api/behavior/refresh-cache` | [src/web/web_admin.routes.js:446](../../src/web/web_admin.routes.js#L446) | `, async (req, res) => {` |
| POST | `/api/behavior` | [endpoint.js:9900](../../endpoint.js#L9900) | `, async (req, res) => {` |
| POST | `/api/behavior` | [src/web/web_admin.routes.js:426](../../src/web/web_admin.routes.js#L426) | `, async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/cancel-test` | [billing_subscriptions.js:112](../../billing_subscriptions.js#L112) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/reconcile` | [billing_subscriptions.js:106](../../billing_subscriptions.js#L106) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/billing/accounts/:owner/test-subscription` | [billing_subscriptions.js:101](../../billing_subscriptions.js#L101) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| POST | `/api/bot-test/reset` | [bot_test_panel.js:307](../../bot_test_panel.js#L307) | `, botTestJson, async (req, res) => {` |
| POST | `/api/bot-test/send` | [bot_test_panel.js:254](../../bot_test_panel.js#L254) | `, botTestJson, async (req, res) => {` |
| POST | `/api/client-phone-access` | [client_phone_access.js:411](../../client_phone_access.js#L411) | `, requireAdmin, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/classify` | [conversation_followup_panel.js:1480](../../conversation_followup_panel.js#L1480) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/close` | [conversation_followup_panel.js:1555](../../conversation_followup_panel.js#L1555) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/reopen` | [conversation_followup_panel.js:1385](../../conversation_followup_panel.js#L1385) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id/send` | [conversation_followup_panel.js:1431](../../conversation_followup_panel.js#L1431) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/:id` | [conversation_followup_panel.js:1498](../../conversation_followup_panel.js#L1498) | `, async (req, res) => {` |
| POST | `/api/conversation-followup/config` | [conversation_followup_panel.js:1103](../../conversation_followup_panel.js#L1103) | `, async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/sectors/:sector/:action` | [customer_queue.js:374](../../customer_queue.js#L374) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/settings` | [customer_queue.js:193](../../customer_queue.js#L193) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/tickets/:id/cancel` | [customer_queue.js:259](../../customer_queue.js#L259) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app-admin/:tenant/tickets/:id/print` | [customer_queue.js:276](../../customer_queue.js#L276) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/activity` | [app_center.js:65](../../app_center.js#L65) | `,json,wrap(async(req,res)=>{` |
| POST | `/api/customer-app/:tenant/devices` | [customer_app_web.js:143](../../customer_app_web.js#L143) | `, async (req,res)=>{ try{const t=tenant(req.params.tenant),installId=clean(req.body.installId,120),pushToken=c` |
| POST | `/api/customer-app/:tenant/presence/checkin` | [customer_queue.js:161](../../customer_queue.js#L161) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/cancel` | [customer_queue.js:359](../../customer_queue.js#L359) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/claim` | [customer_queue.js:310](../../customer_queue.js#L310) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [customer_queue.js:337](../../customer_queue.js#L337) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [deploy/mecan-install/patch-runtime.cjs:25](../../deploy/mecan-install/patch-runtime.cjs#L25) | `, wrap(async (req, res) => {", "  app.post('/api/customer-app/:tenant/tickets/:id/handoff', wrap(async (req, r` |
| POST | `/api/customer-app/:tenant/tickets/:id/handoff` | [deploy/mecan-install/patch-runtime.cjs:25](../../deploy/mecan-install/patch-runtime.cjs#L25) | `, wrap(async (req, res) => {\n    const expiresAt = new Date(Date.now() + handoffDuration(req.body?.purpose));` |
| POST | `/api/customer-app/:tenant/tickets` | [customer_queue.js:221](../../customer_queue.js#L221) | `, wrap(async (req, res) => {` |
| POST | `/api/customer-notifications/:tenant/center/send` | [app_center.js:49](../../app_center.js#L49) | `,guard,access,json,wrap(async(req,res)=>{` |
| POST | `/api/customer-notifications/:tenant` | [customer_notifications.js:17](../../customer_notifications.js#L17) | `,requireAuth,notificationJson,async(req,res)=>{const t=tenant(req.params.tenant);if(!t&#124;&#124;!canUse(req,` |
| POST | `/api/customer-notifications/:tenant` | [deploy/patch-notification-devices.cjs:7](../../deploy/patch-notification-devices.cjs#L7) | `,",'async function firebaseSender(){']){` |
| POST | `/api/ext/ayuda/chat-web` | [help_tool.js:2306](../../help_tool.js#L2306) | `, json, async (req, res) => {` |
| POST | `/api/ext/ayuda/playlists` | [help_playlists.js:79](../../help_playlists.js#L79) | `, requireAccess, json, (req, res) => handle(req, res, true));` |
| POST | `/api/ext/ayuda` | [help_tool.js:2329](../../help_tool.js#L2329) | `, json, requireHelpExternalAccess, handleHelpQuery);` |
| POST | `/api/ext/help/playlists` | [help_playlists.js:82](../../help_playlists.js#L82) | `, requireAccess, json, (req, res) => handle(req, res, true));` |
| POST | `/api/ext/help` | [help_tool.js:2327](../../help_tool.js#L2327) | `, json, requireHelpExternalAccess, handleHelpQuery);` |
| POST | `/api/ext/qr/chat` | [qr_product_web.js:1701](../../qr_product_web.js#L1701) | `, qrJson, async (req, res) => {` |
| POST | `/api/ext/qr/photo` | [qr_product_web.js:1535](../../qr_product_web.js#L1535) | `, qrPhotoJson, async (req, res) => {` |
| POST | `/api/ext/queue-sequence` | [queue_cloud_sync.js:84](../../queue_cloud_sync.js#L84) | `, express.json({ limit: '8kb' }), async (req, res) => {` |
| POST | `/api/ext/queue-sync` | [queue_cloud_sync.js:96](../../queue_cloud_sync.js#L96) | `, express.json({ limit: '10mb' }), async (req, res) => {` |
| POST | `/api/ext/wweb/agent/bootstrap` | [endpoint.js:916](../../endpoint.js#L916) | `, wwebAgentJson, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/db` | [endpoint.js:1005](../../endpoint.js#L1005) | `, wwebAgentJson, wwebAgentRequestMetrics, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/operator-message` | [endpoint.js:1098](../../endpoint.js#L1098) | `, wwebAgentJson, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/agent/ping` | [endpoint.js:975](../../endpoint.js#L975) | `, wwebAgentJson, requireWwebAgentAccess, async (req, res) => {` |
| POST | `/api/ext/wweb/chatgpt/process` | [endpoint.js:10681](../../endpoint.js#L10681) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/api/ext/wweb/manager/intent` | [endpoint.js:10685](../../endpoint.js#L10685) | `, async (req, res) => {` |
| POST | `/api/fleteros/api-config` | [fleteros_viajes_panel.js:2733](../../fleteros_viajes_panel.js#L2733) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/cpe/parse` | [fleteros_viajes_panel.js:2769](../../fleteros_viajes_panel.js#L2769) | `, requireAuth, maybeUploadCpe, async (req, res) => {` |
| POST | `/api/fleteros/seed-demo` | [fleteros_viajes_panel.js:2876](../../fleteros_viajes_panel.js#L2876) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/viajes/:id/sync-terceros` | [fleteros_viajes_panel.js:2848](../../fleteros_viajes_panel.js#L2848) | `, requireAuth, async (req, res) => {` |
| POST | `/api/fleteros/viajes` | [fleteros_viajes_panel.js:2892](../../fleteros_viajes_panel.js#L2892) | `, requireAuth, async (req, res) => {` |
| POST | `/api/hours` | [endpoint.js:10348](../../endpoint.js#L10348) | `, async (req, res) => {` |
| POST | `/api/hours` | [src/web/web_admin.routes.js:514](../../src/web/web_admin.routes.js#L514) | `, async (req, res) => {` |
| POST | `/api/order-config/current` | [order_config_panel.js:336](../../order_config_panel.js#L336) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/products/:id/inactivate` | [endpoint.js:7933](../../endpoint.js#L7933) | `, async (req, res) => {` |
| POST | `/api/products/:id/inactivate` | [src/web/web_admin.routes.js:140](../../src/web/web_admin.routes.js#L140) | `, async (req, res) => {` |
| POST | `/api/products/:id/reactivate` | [endpoint.js:7950](../../endpoint.js#L7950) | `, async (req, res) => {` |
| POST | `/api/products/:id/reactivate` | [src/web/web_admin.routes.js:157](../../src/web/web_admin.routes.js#L157) | `, async (req, res) => {` |
| POST | `/api/products/bulk-save` | [endpoint.js:7814](../../endpoint.js#L7814) | `, async (req, res) => {` |
| POST | `/api/products/images` | [restaurant_image.js:13](../../restaurant_image.js#L13) | `, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), async (req, res) => {` |
| POST | `/api/products` | [endpoint.js:7717](../../endpoint.js#L7717) | `, async (req, res) => {` |
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
| POST | `/api/tenant-channels` | [endpoint.js:400](../../endpoint.js#L400) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tenant-channels` | [src/web/tenant_channels.routes.js:47](../../src/web/tenant_channels.routes.js#L47) | `, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tenant-config` | [auth_ui.js:5134](../../auth_ui.js#L5134) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api/tg/policy` | [telegram_runtime.js:2394](../../telegram_runtime.js#L2394) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/release` | [telegram_runtime.js:2351](../../telegram_runtime.js#L2351) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/reload` | [telegram_runtime.js:2342](../../telegram_runtime.js#L2342) | `, auth.requireAuth, auth.requireAdmin, async (_req, res) => {` |
| POST | `/api/tg/restart` | [telegram_runtime.js:2378](../../telegram_runtime.js#L2378) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/tg/start` | [telegram_runtime.js:2364](../../telegram_runtime.js#L2364) | `, auth.requireAuth, auth.requireAdmin, async (req, res) => {` |
| POST | `/api/token-control/messages/:id/media` | [token_control_media.js:33](../../token_control_media.js#L33) | `, auth.requireAuth, superOnly, wrap(async (req, res) => {` |
| POST | `/api/wweb/action` | [auth_ui.js:6250](../../auth_ui.js#L6250) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/delete-session` | [auth_ui.js:5921](../../auth_ui.js#L5921) | `, requireAuth, requireAdmin, async (req, res) => {` |
| POST | `/api/wweb/policy` | [auth_ui.js:5974](../../auth_ui.js#L5974) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/policy` | [endpoint.js:1754](../../endpoint.js#L1754) | `, async (req, res) => {` |
| POST | `/api/wweb/release` | [auth_ui.js:5849](../../auth_ui.js#L5849) | `, requireAuth, requireWwebAccess, async (req, res) => {` |
| POST | `/api/wweb/release` | [endpoint.js:1795](../../endpoint.js#L1795) | `, async (req, res) => {` |
| POST | `/approve` | [src/support/devices.js:89](../../src/support/devices.js#L89) | `, route(async (req, s) => {` |
| POST | `/contact-control` | [src/support/extension.js:129](../../src/support/extension.js#L129) | `, route(async (req, s, scope) => {` |
| POST | `/contact` | [auth_ui.js:3411](../../auth_ui.js#L3411) | `, async (req, res) => {` |
| POST | `/contact` | [src/support/extension.js:141](../../src/support/extension.js#L141) | `, route(async (req, s, scope) => {` |
| POST | `/contacts` | [src/support/devices.js:165](../../src/support/devices.js#L165) | `, route(async (req, s) => {` |
| POST | `/contacts` | [src/support/extension.js:149](../../src/support/extension.js#L149) | `, route(async (req, s, scope) => {` |
| POST | `/control/release` | [app_asisto_ws.js:775](../../app_asisto_ws.js#L775) | `, requireStatusToken, async (req, res) => {` |
| POST | `/drafts/:id/acknowledge-source` | [src/support/routes.js:65](../../src/support/routes.js#L65) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/approve` | [src/support/routes.js:64](../../src/support/routes.js#L64) | `, route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, {}, true)));` |
| POST | `/drafts/:id/discard-changes` | [src/support/extension.js:273](../../src/support/extension.js#L273) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/dismiss` | [src/support/extension.js:265](../../src/support/extension.js#L265) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/mail` | [src/support/extension.js:65](../../src/support/extension.js#L65) | `, route(async (req,s,scope) => { const row = await rowFor(s,scope,req.params.id); return mailFactory(s).send(s` |
| POST | `/drafts/:id/manual-complete` | [src/support/extension.js:252](../../src/support/extension.js#L252) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/publish` | [src/support/extension.js:340](../../src/support/extension.js#L340) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/queue` | [src/support/extension.js:240](../../src/support/extension.js#L240) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/reconcile` | [src/support/extension.js:219](../../src/support/extension.js#L219) | `, route(async (req, s, scope) => {` |
| POST | `/drafts/:id/resolve-followup` | [src/support/extension.js:208](../../src/support/extension.js#L208) | `, route(resolveFollowup));` |
| POST | `/drafts/:id/save` | [src/support/extension.js:209](../../src/support/extension.js#L209) | `, route((req, s, scope) => {` |
| POST | `/heartbeat` | [src/support/devices.js:108](../../src/support/devices.js#L108) | `, route(async (req, s) => {` |
| POST | `/history` | [src/support/routes.js:59](../../src/support/routes.js#L59) | `, route((req, s, scope) => s.history(scope, req.body.from, req.body.to)));` |
| POST | `/hubspot/connect` | [src/support/extension.js:294](../../src/support/extension.js#L294) | `, route(async (req, s, scope) => {` |
| POST | `/login` | [auth_ui.js:3525](../../auth_ui.js#L3525) | `, async (req, res) => {` |
| POST | `/logout` | [auth_ui.js:3609](../../auth_ui.js#L3609) | `, (req, res) => {` |
| POST | `/mail/settings` | [src/support/extension.js:62](../../src/support/extension.js#L62) | `, route(async (req,s,scope) => mailFactory(s).save(scope,req.body)));` |
| POST | `/mail/verify` | [src/support/extension.js:63](../../src/support/extension.js#L63) | `, route(async (req,s,scope) => mailFactory(s).verify(scope)));` |
| POST | `/messages/assign` | [src/support/extension.js:120](../../src/support/extension.js#L120) | `, route((req, s, scope) => s.assignMessages(scope, req.body)));` |
| POST | `/messages` | [src/support/devices.js:153](../../src/support/devices.js#L153) | `, route(async (req, s) => {` |
| POST | `/poll` | [src/support/devices.js:79](../../src/support/devices.js#L79) | `, route(async (req, s) => {` |
| POST | `/revoke` | [src/support/devices.js:101](../../src/support/devices.js#L101) | `, route(async (req, s) => {` |
| POST | `/session` | [src/support/devices.js:123](../../src/support/devices.js#L123) | `, route(async (req, s) => {` |
| POST | `/session` | [src/support/routes.js:52](../../src/support/routes.js#L52) | `, route(async (req, s, scope) => {` |
| POST | `/start` | [src/support/devices.js:65](../../src/support/devices.js#L65) | `, route(async (req, s) => {` |
| POST | `/v200/api/Api_Chat_Cab/ProcesarMensajePost` | [endpoint.js:10682](../../endpoint.js#L10682) | `, handleApiChatCabProcesarMensajePost);` |
| POST | `/webhook` | [endpoint.js:12511](../../endpoint.js#L12511) | `, handleWebhookPost);` |
| POST | `/webhook` | [src/whatsapp/webhook.routes.js:76](../../src/whatsapp/webhook.routes.js#L76) | `, async (req, res) => {` |
| POST | `/webhooks/mercadopago/subscriptions` | [billing_subscriptions.js:120](../../billing_subscriptions.js#L120) | `, express.json({ limit: '16kb' }), async (req, res) => {` |
| POST | `/whatsapp/session` | [src/support/extension.js:54](../../src/support/extension.js#L54) | `, route(async (req, s, scope) => {` |
| POST | `/work` | [src/support/devices.js:178](../../src/support/devices.js#L178) | `, route(async (req, s) => {` |
| PUT | `/api/billing/accounts/:owner` | [billing_subscriptions.js:96](../../billing_subscriptions.js#L96) | `, auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {` |
| PUT | `/api/customer-app-admin/:tenant/sellers` | [customer_queue.js:134](../../customer_queue.js#L134) | `, wrap(async (req, res) => {` |
| PUT | `/api/fleteros/viajes/:id` | [fleteros_viajes_panel.js:2965](../../fleteros_viajes_panel.js#L2965) | `, requireAuth, async (req, res) => {` |
| PUT | `/api/monetization/config` | [monetization_config.js:49](../../monetization_config.js#L49) | `,auth.requireAuth,requireSuper,async(req,res)=>{const tenantId=tenant(req.body?.tenantId);if(!tenantId)return ` |
| PUT | `/api/products/:id` | [endpoint.js:7764](../../endpoint.js#L7764) | `, async (req, res) => {` |
| PUT | `/api/products/:id` | [src/web/web_admin.routes.js:80](../../src/web/web_admin.routes.js#L80) | `, async (req, res) => {` |
| PUT | `/api/resto/settings` | [restaurant_operations.js:169](../../restaurant_operations.js#L169) | `, (_req,res)=>res.status(410).json({ error:'Configurá estas variables en Configuración de dominio.' }));` |
| PUT | `/hubspot` | [src/support/routes.js:84](../../src/support/routes.js#L84) | `, route(async () => { requireHubSpot(); fail('hubspot_backend_managed', 410); }));` |
| PUT | `/memory/verify` | [src/support/routes.js:76](../../src/support/routes.js#L76) | `, route(async (req, s, scope) => {` |
| PUT | `/memory` | [src/support/routes.js:75](../../src/support/routes.js#L75) | `, route((req, s, scope) => s.rememberContact(scope, req.body)));` |
| PUT | `/settings` | [src/support/routes.js:45](../../src/support/routes.js#L45) | `, route((req, s, scope) => s.saveConfig(scope, req.body)));` |
| PUT | `/tenant-settings` | [src/support/routes.js:46](../../src/support/routes.js#L46) | `, route((req, s, scope) => { admin(req); return s.saveConfig({ ...scope, userId: '*' }, req.body); }));` |
| USE | `/api/customer-app-admin` | [customer_app_web.js:136](../../customer_app_web.js#L136) | `, express.json({ limit: "32kb" }));` |
| USE | `/api/customer-app` | [customer_app_web.js:135](../../customer_app_web.js#L135) | `, express.json({ limit: "32kb" }));` |
| USE | `/api/support/device` | [src/support/routes.js:120](../../src/support/routes.js#L120) | `, createDeviceRouter({ getService, publicOrigin }));` |
| USE | `/api/support/extension` | [src/support/routes.js:121](../../src/support/routes.js#L121) | `, createExtensionRouter({ getService }));` |
| USE | `/api/support` | [src/support/routes.js:122](../../src/support/routes.js#L122) | `, createRouter({ getService, publicOrigin }));` |
| USE | `/api/support` | [src/support/routes.js:124](../../src/support/routes.js#L124) | `, (req, res) => {` |
| USE | `/api/wweb` | [endpoint.js:486](../../endpoint.js#L486) | `, auth.requireWwebAccess);` |
| USE | `/customer-app/assets` | [customer_app_web.js:137](../../customer_app_web.js#L137) | `, express.static(require('path').join(__dirname, 'static', 'turnero')));` |
| USE | `/static/clientes` | [endpoint.js:151](../../endpoint.js#L151) | `, express.static(path.join(__dirname, "static", "clientes")));` |
| USE | `/static` | [endpoint.js:154](../../endpoint.js#L154) | `, express.static(path.join(__dirname, "static")));` |
| USE | `/static` | [endpoint.js:157](../../endpoint.js#L157) | `, express.static(path.join(__dirname)));` |
| USE | `/ui` | [endpoint.js:169](../../endpoint.js#L169) | `, auth.requireAuth);` |
