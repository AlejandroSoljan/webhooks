# API de Ayuda

## Playlists persistentes (implementación 19/11/2026, pendiente de publicación)

La integración permite crear, recuperar y listar playlists sin IA ni lectura de Google Sheets/Vimeo. Reutiliza la clave global del servicio Ayuda en `X-API-Key`, `X-Asisto-Key` o `Authorization: Bearer`. En estas rutas enviar la clave en encabezados, nunca en el cuerpo o URL. Es una API servidor a servidor: la clave de integración habilita todos los agentes, no representa una credencial de usuario ni una clave limitada a un tenant.

`agente` es opcional (predeterminado `MANAGER`) y se normaliza a mayúsculas. El dueño se obtiene de la configuración de Ayuda existente (MANAGER corresponde a MSM según configuración); el cliente no puede elegir el dueño enviando `tenantId` o `dominio`. Cada escritura y lectura usa el dueño resuelto y el agente. Una playlist de otro dueño/agente devuelve 404 y no aparece en el listado. La habilitación se verifica en cada solicitud. No requiere `version`, `ventana`, `consulta` ni `usuario`.

| Método | Ruta | Resultado |
|---|---|---|
| POST | `/api/ext/ayuda/playlists` | Alta; HTTP 201 con `id` UUID y datos guardados |
| GET | `/api/ext/ayuda/playlists/:id?agente=MANAGER` | Consulta individual; HTTP 200 |
| GET | `/api/ext/ayuda/playlists?agente=MANAGER&offset=0` | Listado del servicio; HTTP 200 |

Las tres rutas también admiten el prefijo `/api/ext/help/playlists`.

Ejemplo de cuerpo de alta (IDs sintéticos):

```json
{
  "agente": "MANAGER",
  "nombre": "Primeros pasos",
  "descripcion": "Recorrido inicial por las funciones de Manager",
  "vimeo_ids": ["300", "100", "200"]
}
```

`nombre` y `descripcion` son textos obligatorios no vacíos, de hasta 200 y 4000 caracteres respectivamente. `vimeo_ids` debe contener entre 1 y 500 strings numéricos positivos de hasta 20 dígitos, sin espacios ni ceros iniciales. No enviar números JSON: los IDs son strings. El orden y los repetidos se conservan exactamente; no se verifica existencia, visibilidad ni disponibilidad en Vimeo. El cuerpo está limitado a 128 KB.

Alta y consulta individual devuelven:

```json
{
  "ok": true,
  "id": "e6115716-8267-4287-9d2a-3a18a2fbc28e",
  "agente": "MANAGER",
  "nombre": "Primeros pasos",
  "descripcion": "Recorrido inicial por las funciones de Manager",
  "vimeo_ids": ["300", "100", "200"],
  "creada_en": "2026-11-19T15:00:00.000Z"
}
```

Listado: `{ "ok": true, "playlists": [...], "limit": 100, "offset": 0, "has_more": false }`. Cada elemento contiene los mismos campos de playlist sin `ok`. Orden: creación descendente y, en empates, ID descendente. `limit`: 1–100 (default 100); `offset`: 0–10000 (default 0). Si `has_more` es true, sumar `limit` a `offset`. Un servicio habilitado sin playlists devuelve una lista vacía. La paginación no es una fotografía: altas concurrentes pueden desplazar posiciones.

Errores JSON: 400 (`agente_invalid`, `nombre_invalid`, `descripcion_invalid`, `vimeo_ids_invalid`, `playlist_id_invalid`, `limit_invalid`, `offset_invalid`), 401 (`unauthorized`), 403 (`help_disabled`), 404 (`playlist_not_found`), 500 (`playlist_internal_error`, sin detalles internos). JSON malformado y cuerpos excesivos usan los errores 400/413 del parser Express. Respuestas del handler con `Cache-Control: no-store`.

Persistencia: colección `help_playlists`, UUID en `_id`, `tenantId` del dueño, agente, datos y fecha UTC. Mongo garantiza unicidad por `_id`; el primer alta crea el índice `{tenantId:1, agente:1, creada_en:-1, _id:-1}` para el listado. No hay caducidad automática, migración de documentos ni variables nuevas. Incorporar la colección al alcance habitual de respaldo. Requiere desplegar el backend; no modifica playlists de Vimeo. Cada POST crea una playlist nueva, incluso con el mismo contenido: ante un timeout no reintentar ciegamente; consultar el listado. No incluye modificación ni eliminación.

Verificación: `node --test tests/help_playlists.test.js tests/help_tool.test.js` (10 pruebas aprobadas con Node 24 y almacenamiento simulado, sin datos productivos). Cubre alta/consulta, orden/repetidos, IDs únicos, listado/paginación, campos inválidos, autenticación real del montaje, servicio deshabilitado, aislamiento de dueño/agente y errores de persistencia. Pendiente: integración y despliegue; no se verificó MongoDB ni AWS productivos.

## Consulta contextual existente

Los endpoints `GET/POST /api/ext/help` y `/api/ext/ayuda` reciben `agente`, `ventana`, `version`, `dominio` y `usuario`.

En las consultas por ventana, el backend valida acceso, versión y estructura de la fuente, y envía los videos candidatos junto con el comportamiento vigente configurado en MSM al modelo del agente. La respuesta del modelo define simultáneamente qué IDs se incluyen y su orden. El backend valida que los IDs existan en la fuente, elimina duplicados y conserva exactamente ese orden; no completa videos omitidos ni aplica después un orden fijo por `Importancia`.

El cambio del comportamiento invalida naturalmente el cache porque su hash forma parte de la clave. También invalidan el cache los cambios de título, tipo, ventana aplicable, versión, importancia, tags o descripción. Por lo tanto, modificar reglas de selección, obligatoriedad de campos u orden en MSM no requiere publicar una nueva versión del backend.

La columna opcional `Tipo` se entrega al modelo como contexto y se devuelve en cada video como `tipo`. Los campos de salida conservan además `vimeo_id`, `titulo`, `caratula`, `importancia` y `descripcion`.
