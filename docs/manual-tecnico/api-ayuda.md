# API de Ayuda

Los endpoints `GET/POST /api/ext/help` y `/api/ext/ayuda` reciben `agente`, `ventana`, `version`, `dominio` y `usuario`.

En las consultas por ventana, el backend valida acceso, versión y estructura de la fuente, y envía los videos candidatos junto con el comportamiento vigente configurado en MSM al modelo del agente. La respuesta del modelo define simultáneamente qué IDs se incluyen y su orden. El backend valida que los IDs existan en la fuente, elimina duplicados y conserva exactamente ese orden; no completa videos omitidos ni aplica después un orden fijo por `Importancia`.

El cambio del comportamiento invalida naturalmente el cache porque su hash forma parte de la clave. También invalidan el cache los cambios de título, tipo, ventana aplicable, versión, importancia, tags o descripción. Por lo tanto, modificar reglas de selección, obligatoriedad de campos u orden en MSM no requiere publicar una nueva versión del backend.

La columna opcional `Tipo` se entrega al modelo como contexto y se devuelve en cada video como `tipo`. Los campos de salida conservan además `vimeo_id`, `titulo`, `caratula`, `importancia` y `descripcion`.
