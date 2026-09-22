<!-- Asisto | Version: 5.00.141 | Fecha: 2026-09-16 -->
# Avisos de leads del formulario público

Para recibir por WhatsApp los contactos enviados desde `/login#contacto`,
configurar en el servidor productivo de AWS:

- `LEAD_NOTIFY_WWEB_TENANT`: dominio de la sesión emisora.
- `LEAD_NOTIFY_WWEB_FROM`: número de esa sesión, con código de país.
- `LEAD_NOTIFY_WWEB_TO`: número administrador destinatario, con código de país.

Los tres valores son obligatorios. Se usa la cola `wa_wweb_actions` existente;
el estado `queued` indica que se encoló, **no confirma entrega**. Si falta
configuración o sesión, el lead igualmente se guarda en `leads` y se registra
`whatsappAlertStatus` para revisar los pendientes. No se usa Render.
