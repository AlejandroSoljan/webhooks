# Indicaciones para trabajar en Asisto

- Partí de `origin/main` y creá una rama `codex/<servicio>`. Usá un pull request para integrar cambios.
- Leé [la guía de colaboración](docs/COLABORACION.md) y el [manual técnico](docs/MANUAL_TECNICO_ASISTO.md) antes de tocar rutas, configuración o datos.
- En desarrollo usá datos sintéticos y configuración de pruebas. No copies ni uses credenciales, sesiones ni datos productivos.
- Para funciones por dominio, aplicá los controles de permisos y el filtro de tenant existentes a toda lectura y escritura. Probá el caso de acceso desde otro dominio.
- Documentá cambios de API, configuración y operación en el manual correspondiente y ejecutá las pruebas aplicables. La integración requiere el check `build (24.x)`.
