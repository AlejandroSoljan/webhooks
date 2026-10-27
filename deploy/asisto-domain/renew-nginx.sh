#!/bin/sh
# Certbot deploy hook: sólo recarga una configuración válida.
set -eu
nginx -t
systemctl reload nginx
