# Suscripciones de clientes · preparación de Mercado Pago

Estado: primera etapa implementada el 2026-10-01. **No genera débitos reales ni facturas.**
Panel central: `/admin/billing`, accesible desde Control de Consumos → “Suscripciones y cobros · preparación”. Sólo superadmin, incluso por API. No cambia el turnero, agentes locales, conexiones de clientes ni tarifas de consumos.

## Qué está disponible

- Configuración persistente por titular: email de facturación y día previsto (1–28). Período mensual calendario, moneda ARS y consumo variable. Guardar no llama a Mercado Pago.
- Dominios secundarios agrupados desde `tenant_config.consumption_domains`, la misma relación de configuración del reporte, no una lista fija de clientes. Detecta ciclos y más de un titular; bloquea la operación ante ambigüedad.
- Integración de prueba sin plan asociado: alta `pending`, enlace de adhesión, consulta de estado y cancelación de prueba. **ARS 10 de prueba**, no el consumo del cliente ni una tarifa comercial.
- Comprador y vendedor verificados como cuentas `test_user` diferentes antes de operar. El email usado para la prueba se obtiene de la cuenta de prueba, nunca del email del cliente real.
- Reserva persistente antes del alta: timeout/resultado incierto queda `unknown` y no se vuelve a crear. “Consultar en Mercado Pago” busca por referencia externa para recuperar el resultado.
- Webhooks firmados, consulta del recurso al proveedor, verificación de cuenta/moneda/importe y registro idempotente del estado de pagos de prueba. Un pago real (`live_mode: true`) se rechaza.
- La vuelta del navegador no aprueba pagos. `authorized` es autorización de la suscripción, no pago del mes. No se actualiza ningún saldo ni factura real.

## Configurar exclusivamente en AWS

En el entorno del backend central, mediante el procedimiento seguro habitual, configurar sin publicar valores:

| Variable | Valor/función |
|---|---|
| `MP_SUBSCRIPTIONS_MODE` | `disabled` por defecto; únicamente `test` habilita pruebas. `production` no existe y queda deshabilitado. |
| `MP_SUBSCRIPTIONS_ACCESS_TOKEN` | Credencial del vendedor de prueba. No admite una cuenta vendedora real. |
| `MP_SUBSCRIPTIONS_WEBHOOK_SECRET` | Secreto de firma de notificaciones de la aplicación de prueba. |
| `MP_SUBSCRIPTIONS_TEST_PAYER_ID` | ID numérico del comprador de prueba, diferente del vendedor. |
| `MP_SUBSCRIPTIONS_PUBLIC_URL` | Origen HTTPS público, por ejemplo `https://www.asistobot.com.ar`, sin ruta ni query. |

Configurar en Mercado Pago los tópicos `subscription_preapproval`, `subscription_authorized_payment` y `payment`, apuntando a `/webhooks/mercadopago/subscriptions`. No poner tokens en URL, HTML, archivos versionados o mensajes. No almacenar tarjeta, CVV ni datos completos de respuestas del proveedor.

Las variables no fueron activadas ni se crearon cuentas de Mercado Pago durante el desarrollo. Sin credenciales, las funciones de prueba quedan bloqueadas y la configuración de clientes puede guardarse.

## Flujo de prueba

1. Corregir las asociaciones de dominios si el panel detecta un conflicto. Seleccionar siempre el titular.
2. Guardar email y día previsto. Ese día aún no programa cobros.
3. Configurar vendedor/comprador de prueba y webhook en el servidor.
4. Pulsar Crear adhesión de prueba; confirmar el importe ficticio mensual de ARS 10.
5. Abrir el enlace con la cuenta compradora de prueba y un medio de pago de prueba.
6. Consultar el estado; verificar notificaciones y pagos. Probar rechazo, reembolso y cancelación antes de ampliar el sistema.
7. Cancelar la prueba al terminar. Sólo se admite una prueba por titular en esta etapa; no borrar su reserva ante un timeout. Una prueba cancelada conserva su historial. Para repetir un ciclo de alta debe diseñarse una nueva generación auditable, no borrar a ciegas el registro.

## API interna

Todos los endpoints `/api/billing/*` requieren sesión y rol `superadmin`; no aceptan una API key de mensajes. Escrituras: JSON y header `X-Asisto-Billing: 1`, sin CORS. Respuestas privadas `Cache-Control: no-store`.

| Método y ruta | Contrato |
|---|---|
| `GET /api/billing/accounts` | Titulares, dominios asociados, perfiles, suscripción de prueba, últimos 100 pagos de prueba y presencia (no valores) de configuración. |
| `PUT /api/billing/accounts/:owner` | `{ "billingEmail": "administracion@example.com", "collectionDay": 5 }`. No permite cambiar moneda ni activar cobros. |
| `POST /api/billing/accounts/:owner/test-subscription` | `{}`. Reserva y crea una adhesión sólo de prueba. |
| `POST /api/billing/accounts/:owner/reconcile` | `{}`. Consulta al proveedor; recupera altas inciertas. |
| `POST /api/billing/accounts/:owner/cancel-test` | `{}`. Cancela la suscripción de prueba en Mercado Pago y vuelve a consultarla. |
| `POST /webhooks/mercadopago/subscriptions` | Público con firma HMAC obligatoria. ID de query `data.id` debe coincidir con body. Responde 401 a firma inválida y 503 ante fallo recuperable para que el proveedor reintente. |
| `GET /webhooks/mercadopago/subscriptions/return` | Página informativa pública; no altera estados. |

Errores internos del proveedor no se devuelven con cuerpos sensibles. La firma se verifica con `x-signature`, `x-request-id` y `data.id`; los reintentos se concilian por ID y fecha del recurso para no retroceder el estado por notificaciones viejas. En producción será necesario añadir cola persistente, reintentos internos y alertas, no depender exclusivamente del reenvío del webhook.

## Colecciones nuevas

- `billing_profiles`: `_id` titular; parámetros y autor/fecha de última modificación.
- `billing_subscriptions`: `_id` `test:TITULAR`; referencia externa UUID, vendedor, ID remoto, estado y URL validada. La clave única `_id` impide dos altas concurrentes por titular.
- `billing_payments`: `_id` `test:ID_MP`; titular, suscripción, importe, moneda, estado verificado y fecha del proveedor. No es el libro de facturas productivas.

No se escriben consumos, perfiles de monetización, saldos ni conversaciones. Las pruebas automatizadas usan MongoDB temporal, no AWS.

## Antes de habilitar débitos reales (pendiente)

1. Unificar la liquidación monetaria en servidor y conciliarla con Control de Consumos. Hoy el reporte combina importes en frontend; no enviarlos directamente a Mercado Pago. Revisar diferencias de límites UTC/Argentina en resúmenes y valorizar IA por modelo real, no una tarifa agregada máxima.
2. Cerrar cada mes de Argentina en una liquidación única titular+período. Congelar orígenes, cantidades, tarifas, créditos, USD, cotización oficial/fecha y total ARS. Un mes abierto sólo es estimación. Prever ajustes auditable sin sobrescribir liquidaciones pagadas.
3. Definir fecha de vencimiento, política de cambio de importe, aviso/consentimiento del cliente, corte ante morosidad, reintentos y reembolsos. El día guardado en este panel es preparatorio.
4. Mercado Pago permite modificar una suscripción, pero el cambio de monto no identifica por sí solo una factura ni evita repetir el importe previo si falla el cierre siguiente. Probar ese ciclo y bloquear cargos no conciliados antes de habilitar automatización.
5. Implementar aprobación y programación de importes variables, conciliación por período e importe, saldo pendiente/parcial/pagado/reembolsado/contracargo e idempotencia de cada débito.
6. Configurar credenciales reales y obtener autorización de clientes solamente después de la validación integral. La implementación actual no contiene ese modo.

## Pruebas y fuentes

Ejecutar `node --test tests/billing_subscriptions.test.js`, luego `npm test`.

Documentación oficial consultada:
- [Alta sin plan con autorización pendiente](https://www.mercadopago.com.ar/developers/en/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments).
- [Consultar suscripción](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval/get).
- [Modificar suscripción](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/update-preapproval/put).
- [Notificaciones y validación de firma](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks).

Las pruebas locales simulan las respuestas de Mercado Pago; no sustituyen una prueba integrada con credenciales y webhook públicos.
