# Despliegue automático en Lightsail

El servidor consulta `main` de GitHub cada dos minutos. Si hay un commit nuevo,
crea un release sin `configuracion.json` ni `.env`, instala dependencias con
`npm ci`, ejecuta `npm test`, cambia el enlace `current` y reinicia
`asisto-production`. Si `/healthz` no responde, vuelve al release anterior.
Un commit que falla queda marcado para evitar reintentos infinitos; un commit
posterior se intenta normalmente. Los releases anteriores no se borran.

Instalación en **asisto-linux** (cuenta AWS 401905376919):

```bash
sudo install -m 0755 deploy/lightsail/auto-deploy.sh /usr/local/sbin/asisto-auto-deploy
sudo install -m 0644 deploy/lightsail/asisto-auto-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/lightsail/asisto-auto-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now asisto-auto-deploy.timer
sudo systemctl start asisto-auto-deploy.service
systemctl status asisto-auto-deploy.timer --no-pager
journalctl -u asisto-auto-deploy.service -n 50 --no-pager
```

Este mecanismo despliega la **web/API** de `AlejandroSoljan/webhooks`.
Los agentes de WhatsApp de RVL y NEA usan otro repositorio y se actualizan
mediante su `release_tag`/`auto_update_target_tag` de MongoDB.
