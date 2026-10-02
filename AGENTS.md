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
