# Publicación del backend Asisto

- Antes de publicar cambios del backend o modificar `ASISTO_VERSION.json`, actualizar `HISTORIAL_CAMBIOS_BACKEND.txt` con fecha, versión, comportamiento, impacto operativo, pruebas y commit/tag. Marcar las correcciones que reemplazan versiones previas.
- No dar por desplegado un commit sólo por estar en GitHub; comprobar el release activo y `/healthz` en AWS.
- Todo cambio que afecte al dominio o tenant `MCN` debe publicarse y verificarse en ambos destinos: AWS (`asistobot.com.ar`) y el servidor local de Mecan. No considerarlo terminado ni comunicarlo como completo mientras falte cualquiera de las dos publicaciones.
- Siguen aplicando las instrucciones de `C:\Asisto\AGENTS.md` sobre el MongoDB productivo.

## Manual técnico vivo

- La entrada canónica es `docs/MANUAL_TECNICO_ASISTO.md`.
- Todo cambio de funciones, APIs, autenticación, variables, defaults, instalación o facturación debe actualizar en el mismo cambio el capítulo o manual funcional correspondiente.
- Regenerar inventarios con `node scripts/build_technical_manual.cjs` cuando cambien rutas, variables o colecciones; revisar el diff. El inventario estático no sustituye documentación del contrato ni valida el montaje de una ruta.
- Documentar pruebas, efectos operativos y pendientes reales; no incluir credenciales ni datos de conversaciones/clientes. Las referencias históricas a Render no reemplazan la operación vigente en AWS.

## Colaboración

- Partí de `origin/main` y creá una rama `codex/<servicio>`. Usá un pull request para integrar cambios.
- Leé [la guía de colaboración](docs/COLABORACION.md) y el [manual técnico](docs/MANUAL_TECNICO_ASISTO.md) antes de tocar rutas, configuración o datos.
- En desarrollo usá datos sintéticos y configuración de pruebas. No copies ni uses credenciales, sesiones ni datos productivos.
- Para funciones por dominio, aplicá los controles de permisos y el filtro de tenant existentes a toda lectura y escritura. Probá el caso de acceso desde otro dominio.
- Documentá cambios de API, configuración y operación en el manual correspondiente y ejecutá las pruebas aplicables. La integración requiere el check `build (24.x)`.

## Inicio en otra PC

- Para un checkout nuevo, seguir [Inicio desde otro Codex](docs/INICIO_OTRO_CODEX.md). Esa guía incluye las reglas de acceso a datos productivos para equipos que no tienen C:\Asisto\AGENTS.md.

## Publicación desde cualquiera de las dos PC

Usar la misma secuencia documentada en [Acceso a staging y producción](docs/ACCESO_STAGING_MANAGER_GO.md). Partir de origin/main actualizado, preservar ramas y cambios pendientes, probar el commit en staging y abrir un PR a main. Verificar la revisión integrada y el release activo antes y después de publicar. Si hay cambios directos en AWS, incorporarlos primero al repositorio.
