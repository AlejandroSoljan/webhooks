# Estándares e integración

## Código y datos

- Conservar CommonJS y el estilo del módulo. Evitar refactorizaciones ajenas a la tarea.
- UTF-8; scripts Linux con LF. Sin secretos, respaldos, conversaciones ni datos personales en commits o fixtures.
- Validar entradas y permisos en servidor. Aislar datos por dominio y probar acceso a un dominio ajeno.
- Respetar America/Argentina/Buenos_Aires y explicitar unidades y monedas.
- No convertir errores en ceros aparentes. Separar intentos, resultados, personas y eventos facturables.
- Evitar duplicados al reintentar eventos, envíos o cobros; probar idempotencia cuando corresponda.
- No cambiar tarifas, márgenes, habilitaciones ni agrupaciones como efecto colateral de otra tarea.

## Trabajo simultáneo

Una rama codex/<funcionalidad> por tarea, desde la base acordada. Coordinar edición de archivos compartidos como endpoint.js. Usar commits acotados y pull requests. Resolver conflictos conservando cambios ajenos; no forzar main ni descartar trabajo de otra persona.

Existe Node.js CI para PR a main: Node 24.x, npm ci y npm test. Verificar su ejecución real. Las reglas escritas no activan protección de ramas ni revisiones obligatorias en GitHub.

## Publicación

El responsable asigna una versión global única y actualiza HISTORIAL_CAMBIOS_BACKEND.txt antes de ASISTO_VERSION.json. Registrar commit y destinos. Un push no demuestra despliegue.

Comparar release activo y diferencias AWS/Mecan antes de publicar. No reemplazar releases incrementales con una copia vieja de main. Preparar rollback y verificar /healthz y funcionalidad; los cambios MCN requieren AWS y Mecan.

Una publicación a la vez por destino. Antes de habilitar publicaciones simultáneas, revisar auto-deploy y configurar exclusión mutua en el ejecutor real: concurrencia de GitHub no protege scripts SSH ni temporizadores externos. Esta preparación documental no modifica ejecutores.

## Validación y manual

Actualizar el capítulo funcional junto al código. Regenerar inventarios con node scripts/build_technical_manual.cjs cuando cambien rutas, variables o colecciones; revisar el diff. Ejecutar pruebas pertinentes y declarar las pendientes.

No enviar WhatsApp, correos o notificaciones reales como prueba sin autorización específica. No ejecutar pruebas o migraciones destructivas en Cluster0 para validar desarrollo.
