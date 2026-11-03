# Publicación del backend Asisto

- Antes de publicar cambios del backend o modificar `ASISTO_VERSION.json`, actualizar `HISTORIAL_CAMBIOS_BACKEND.txt` con fecha, versión, comportamiento, impacto operativo, pruebas y commit/tag. Marcar las correcciones que reemplazan versiones previas.
- No dar por desplegado un commit sólo por estar en GitHub; comprobar el release activo y `/healthz` en AWS.
- Todo cambio que afecte al dominio o tenant `MCN` debe publicarse y verificarse en ambos destinos: AWS (`asistobot.com.ar`) y el servidor local de Mecan. No considerarlo terminado ni comunicarlo como completo mientras falte cualquiera de las dos publicaciones.
- La fuente autoritativa publicada es MongoDB `Cluster0` en AWS Lightsail (`asisto-aws`). Confirmar host y base mediante lectura SSH antes de informar datos productivos o aplicar cambios.
- No usar el .env de otra PC, Atlas o copias locales como sustitutos de producción. Si falla el acceso AWS, informar el bloqueo y no escribir en otra copia.
- MongoDB permanece en loopback; no exponer 27017 a Internet. El túnel administrativo de esta PC utiliza 127.0.0.1:37017. Cada colaborador necesita acceso individual autorizado; no copiar claves privadas ni secretos al repositorio.
- Estas reglas son portables: no requieren que exista C:\Asisto\AGENTS.md en otra PC.

## Desarrollo compartido

- Leer docs/INCORPORACION_DESARROLLADORES.md, docs/ARQUITECTURA.md y docs/ESTANDARES_DESARROLLO.md antes de comenzar.
- Usar una rama codex/<funcionalidad> desde el commit base acordado. No asumir que main equivale a los releases instalados.
- Los colaboradores entregan pull requests; no despliegan producción sin asignación y autorización explícita del responsable. La verificación AWS/Mecan corresponde a la publicación coordinada, no a cada rama de desarrollo.
- Conservar cambios ajenos, usar datos de prueba y no compartir credenciales.
- Coordinar versiones y publicaciones: una a la vez por destino. No presentar controles pendientes como habilitados.

## Manual técnico vivo

- La entrada canónica es `docs/MANUAL_TECNICO_ASISTO.md`.
- Todo cambio de funciones, APIs, autenticación, variables, defaults, instalación o facturación debe actualizar en el mismo cambio el capítulo o manual funcional correspondiente.
- Regenerar inventarios con `node scripts/build_technical_manual.cjs` cuando cambien rutas, variables o colecciones; revisar el diff. El inventario estático no sustituye documentación del contrato ni valida el montaje de una ruta.
- Documentar pruebas, efectos operativos y pendientes reales; no incluir credenciales ni datos de conversaciones/clientes. Las referencias históricas a Render no reemplazan la operación vigente en AWS.
