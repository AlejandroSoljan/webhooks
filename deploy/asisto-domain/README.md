# Dominio adicional asisto.com.ar

Configurado en AWS `ip-172-26-0-152` el 2026-10-27. La delegación usa `jewel.ns.cloudflare.com` y `kipp.ns.cloudflare.com`; apex apunta a `18.228.233.189` y `www` es alias del apex. Se comprobó acceso directo a nginx, sin depender del proxy de Cloudflare.

`/etc/nginx/sites-available/asisto.com.ar`, habilitado desde `sites-enabled`, sirve ambos nombres con el mismo backend y snippets del turnero/privacidad existentes. HTTP redirige a HTTPS salvo el desafío ACME. No redirige al dominio anterior ni cambia su configuración o certificado. No modifica MongoDB, agentes, URLs de integraciones ni enlaces Android ya publicados para asistobot.com.ar.

Certificado Let's Encrypt para apex y www: `/etc/letsencrypt/live/asisto.com.ar/{fullchain.pem,privkey.pem}`, primer vencimiento 2027-01-25. No copiar claves al repositorio. Emisión webroot `/var/www/asisto-acme`; `certbot.timer` renueva automáticamente. El hook `renewal-hooks/deploy/asisto-nginx` valida nginx antes de recargar. La cuenta ACME se registró sin email; no hay avisos por correo configurados.

Se guardó el bloque HTTP anterior como `/etc/nginx/sites-available/asisto.com.ar.before-https-20261027`. Las plantillas de esta carpeta reproducen HTTP de validación, HTTPS final y hook; las rutas y snippets deben verificarse antes de reinstalar. Nunca reemplazar el bloque de asistobot.com.ar con esta plantilla.

Verificación: TLS público válido desde Windows, ambas raíces redirigen a `/login`, `/healthz` devuelve `{"ok":true}` en ambos nombres y en asistobot.com.ar. Las sesiones del navegador son independientes por nombre: iniciar sesión nuevamente al cambiar de dominio es normal.

Operación: `sudo nginx -t`, `sudo systemctl status certbot.timer`, `sudo certbot certificates`, `sudo certbot renew --cert-name asisto.com.ar --dry-run --run-deploy-hooks`. No reiniciar Mongo ni el backend para renovar un certificado.
