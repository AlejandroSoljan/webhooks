# Desarrollar un servicio de Asisto desde otra PC

Cloná el repositorio con tu cuenta de GitHub y abrí la carpeta `webhooks` desde Codex. La raíz incluye `AGENTS.md`, con las reglas de trabajo, y el [manual técnico](MANUAL_TECNICO_ASISTO.md), con rutas, variables y módulos.

```powershell
git clone https://github.com/AlejandroSoljan/webhooks.git
cd webhooks
git fetch origin
git switch -c codex/nombre-del-servicio origin/main
npm ci
npm test
```

Usá Node.js 24, igual que el CI. Cada servicio se trabaja en su rama y se propone en un PR hacia `main`. Describí el cambio, permisos, configuración nueva, migraciones si las hay y cómo probarlo. Revisá el PR con el responsable de Asisto antes de integrarlo. La rama histórica `develop` no es el punto de partida de los servicios nuevos.

Para probar localmente, usá datos sintéticos y una base separada. Las integraciones externas se prueban con simuladores o cuentas dedicadas de prueba. Si el servicio necesita validación en AWS, coordiná con el mantenedor el despliegue de un commit del PR en staging y la prueba con un dominio de demostración. La publicación en producción es un paso operativo posterior a la validación.
