# Dominio adicional asisto.com.ar

Configurado en AWS `ip-172-26-0-152` el 2026-10-27. La delegación usa `jewel.ns.cloudflare.com` y `kipp.ns.cloudflare.com`; apex apunta a `18.228.233.189` y `www` es alias del apex. Se comprobó acceso directo a nginx, sin depender del proxy de Cloudflare.

`/etc/nginx/sites-available/asisto.com.ar`, habilitado desde `sites-enabled`, sirve ambos nombres con el mismo backend y snippets del turnero/privacidad existentes. HTTP redirige a HTTPS salvo el desafío ACME. No redirige al dominio anterior ni cambia su configuración o certificado. No modifica MongoDB, agentes, URLs de integraciones ni enlaces Android ya publicados para asistobot.com.ar.

Certificado Let's Encrypt para apex y www: `/etc/letsencrypt/live/asisto.com.ar/{fullchain.pem,privkey.pem}`, primer vencimiento 2027-01-25. No copiar claves al repositorio. Emisión webroot `/var/www/asisto-acme`; `certbot.timer` renueva automáticamente. El hook `renewal-hooks/deploy/asisto-nginx` valida nginx antes de recargar. La cuenta ACME se registró sin email; no hay avisos por correo configurados.

Se guardó el bloque HTTP anterior como `/etc/nginx/sites-available/asisto.com.ar.before-https-20261027`. Las plantillas de esta carpeta reproducen HTTP de validación, HTTPS final y hook; las rutas y snippets deben verificarse antes de reinstalar. Nunca reemplazar el bloque de asistobot.com.ar con esta plantilla.

Verificación: TLS público válido desde Windows, ambas raíces redirigen a `/login`, `/healthz` devuelve `{"ok":true}` en ambos nombres y en asistobot.com.ar. Las sesiones del navegador son independientes por nombre: iniciar sesión nuevamente al cambiar de dominio es normal.

Prueba de renovación ACME staging completada correctamente el 2026-10-27, incluido el deploy hook (nginx válido y recarga). La prueba manual usó `--no-random-sleep-on-renew`; no se quitó la espera aleatoria de la tarea programada.

Operación: `sudo nginx -t`, `sudo systemctl status certbot.timer`, `sudo certbot certificates`, `sudo certbot renew --cert-name asisto.com.ar --dry-run --run-deploy-hooks`. No reiniciar Mongo ni el backend para renovar un certificado.

## Enlaces visibles

`patch-branding.cjs` reemplaza el dominio únicamente en siete archivos de presentación: pies del turnero/tickets, ficha de producto, restaurante y agradecimiento de comprobantes. Conserva URLs de apps Android, Install Referrer, agentes Windows/extensión, callbacks, identidad de correo, configuraciones históricas y certificado anterior. Esas integraciones continúan operativas bajo asistobot.com.ar; no se migran con una sustitución textual indiscriminada.

`release-branding.sh` clona la release activa y aplica sólo ese parche en AWS principal, turnero AWS y Mecan. Hace cambio atómico del enlace, reinicio del servicio correspondiente y healthz, con reversión ante fallo. No representa un despliegue integral del commit ni cambia la versión declarada del backend. Guardar su release anterior y verificar contenido público y local.

Publicado 2026-10-27, código `607af86`: AWS principal `ced5f0a5cecc-auto-OXtWSPWb-brand-asisto-20261027`; turneros AWS y Mecan `v5.00.313-mecan-install-20261027-brand-asisto-20261027`. Healthz correcto en los tres, pie nuevo verificado en web pública y Mecan local, panel de restaurante con nuevo dominio. 23/23 pruebas focalizadas aprobadas.

Incidencia de infraestructura observada al publicar: disco AWS 99% (1,1 GiB libres de 77 GiB), múltiples intentos del auto-deploy interrumpidos por TimeoutStartSec de 15 minutos. Se detuvo timer y se solicitó detener el build en curso para evitar acumulación; servicios productivos siguen activos. No se borraron releases anteriores ni se amplió el timeout. Requiere revisión de capacidad, limpieza autorizada y pruebas completas antes de reactivar auto-deploy. No interpretar la publicación acotada como resolución de ese bloqueo.
