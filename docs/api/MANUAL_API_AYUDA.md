<!-- Asisto | Version: 5.00.011 | Fecha: 2026-09-01 -->
# Manual de integración — API de Ayuda de Asisto

## 1. Descripción

La API devuelve contenido de asistencia asociado a una versión de Manager, un dominio y un usuario. Tiene dos modos:

- **Consulta inteligente:** recibe una pregunta y devuelve una respuesta breve con videos relacionados.
- **Ayuda contextual:** recibe el nombre técnico de una ventana y devuelve los videos aplicables.

URL principal:

```text
https://www.asistobot.com.ar/api/ext/ayuda
```

Alias equivalente: `https://www.asistobot.com.ar/api/ext/help`  
Métodos admitidos: `GET` y `POST`.

## 2. Autenticación

Todas las solicitudes requieren una clave. El método recomendado es:

```http
X-API-Key: SU_CLAVE_API
```

También se admiten `Authorization: Bearer SU_CLAVE_API` y `X-Asisto-Key: SU_CLAVE_API`.
No se recomienda enviar la clave en la URL ni en el cuerpo. Nunca debe quedar expuesta en código cliente, repositorios o logs.

Una clave ausente o incorrecta devuelve HTTP `401`:

```json
{"ok":false,"error":"unauthorized"}
```

## 3. Parámetros

Pueden enviarse como JSON mediante `POST` o en la cadena de consulta mediante `GET`.

| Parámetro | Obligatorio | Máximo | Descripción |
|---|---:|---:|---|
| `agente` | No | — | Agente de ayuda. Predeterminado: `MANAGER`. |
| `ventana` | Condicional | 300 | Nombre técnico de la ventana. Es obligatorio si no se envía `consulta`; con `consulta` es contexto opcional. |
| `consulta` | No | 4000 | Pregunta en lenguaje natural. Activa el modo inteligente. |
| `version` | Sí | 80 | Versión de Manager utilizada para filtrar contenido. |
| `dominio` | Sí | 120 | Dominio que origina la consulta. Se normaliza a mayúsculas. |
| `usuario` | Sí | 200 | Identificador del usuario. |

Alias admitidos:

| Principal | Alias |
|---|---|
| `agente` | `agent` |
| `ventana` | `window` |
| `consulta` | `query`, `pregunta` |
| `version` | `versión` |
| `dominio` | `domain`, `tenant`, `tenantId` |
| `usuario` | `user`, `username` |

La fecha no se envía: Asisto la genera en el servidor.

## 4. Consulta inteligente

Se activa al enviar `consulta`. `ventana` es opcional, pero mejora la selección cuando la pregunta se refiere a la pantalla actual.

```bash
curl --request POST "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --header "Content-Type: application/json" \
  --data '{
    "agente": "MANAGER",
    "ventana": "w_pro_abm_productos",
    "consulta": "¿Cómo modifico el precio de un artículo?",
    "version": "5.00",
    "dominio": "CLIENTE_001",
    "usuario": "operador01"
  }'
```

Respuesta de ejemplo:

```json
{
  "respuesta": "Para modificar el precio, ingresá a la edición del artículo y actualizá el valor correspondiente.",
  "fecha": "2026-08-29T19:30:00",
  "vimeo_ids": [
    {
      "vimeo_id": "123456789",
      "titulo": "Modificación de artículos",
      "caratula": "https://ejemplo.com/caratulas/modificacion-articulos.jpg",
      "importancia": 1,
      "descripcion": "Edición de datos y precios de artículos."
    }
  ]
}
```

En este modo, `respuesta` contiene texto. Si no hay información suficiente, devuelve un mensaje indicándolo y `vimeo_ids` puede estar vacío.

## 5. Ayuda contextual por ventana

Sin `consulta`, debe enviarse `ventana`. La API selecciona videos compatibles con la ventana y la versión.

```bash
curl --get "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --data-urlencode "agente=MANAGER" \
  --data-urlencode "ventana=w_pro_abm_productos" \
  --data-urlencode "version=5.00" \
  --data-urlencode "dominio=CLIENTE_001" \
  --data-urlencode "usuario=operador01"
```

Respuesta con resultados:

```json
{
  "respuesta": "S",
  "fecha": "2026-08-29T19:30:00",
  "vimeo_ids": [
    {
      "vimeo_id": "123456789",
      "titulo": "ABM de artículos",
      "caratula": "https://ejemplo.com/caratulas/abm-articulos.jpg",
      "importancia": 1,
      "descripcion": "Operaciones disponibles para artículos."
    }
  ]
}
```

Sin resultados:

```json
{"respuesta":"N","fecha":"2026-08-29T19:30:00","vimeo_ids":[]}
```

## 6. Ejemplo en JavaScript

La clave debe permanecer en un servidor; no debe incluirse en JavaScript ejecutado por el navegador.

```javascript
async function consultarAyuda({ apiKey, ventana, consulta, version, dominio, usuario }) {
  const response = await fetch('https://www.asistobot.com.ar/api/ext/ayuda', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({
      agente: 'MANAGER',
      ventana,
      consulta,
      version,
      dominio,
      usuario
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}
```

## 7. Campos de respuesta

| Campo | Tipo | Descripción |
|---|---|---|
| `respuesta` | string | Texto en modo inteligente; `S` o `N` en modo contextual. |
| `fecha` | string | Fecha y hora del servidor en formato `YYYY-MM-DDTHH:mm:ss`. |
| `vimeo_ids` | array | Videos ordenados por importancia; `1` es la mayor prioridad. |
| `vimeo_ids[].vimeo_id` | string | Identificador del video en Vimeo. |
| `vimeo_ids[].titulo` | string | Título del video. |
| `vimeo_ids[].caratula` | string | Carátula asociada al video, obtenida de la columna `Caratula` o `Carátula` de Drive. Puede ser una cadena vacía. |
| `vimeo_ids[].importancia` | number | Prioridad. Los valores vacíos o `0` quedan al final. |
| `vimeo_ids[].descripcion` | string | Descripción del video. |

Aunque el campo se llama `vimeo_ids`, contiene objetos completos y no solamente identificadores.

## 8. Errores

| HTTP | Error habitual | Causa |
|---:|---|---|
| `400` | `ventana_required` | No se enviaron `ventana` ni `consulta`. |
| `400` | `version_required` | Falta `version`. |
| `400` | `dominio_required` | Falta `dominio`. |
| `400` | `usuario_required` | Falta `usuario`. |
| `401` | `unauthorized` | Clave ausente o incorrecta. |
| `500` | Error interno | Fallo inesperado. |
| `502` | Error de fuente | No se pudo acceder a la fuente de ayuda. |
| `503` | Configuración faltante | Falta una dependencia necesaria para responder. |

Ejemplo de validación:

```json
{"ok":false,"error":"version_required"}
```

## 9. Recomendaciones

1. Usar siempre HTTPS y enviar la clave mediante `X-API-Key`.
2. Mantener la clave solamente en variables de entorno del backend.
3. Definir tiempos de espera y manejar respuestas distintas de HTTP `200`.
4. Enviar un identificador estable en `usuario` para auditoría.
5. Enviar la versión real de Manager; la selección depende de ella.
6. Enviar `ventana` cuando esté disponible, incluso en modo inteligente.
7. Tratar `vimeo_ids` como un arreglo potencialmente vacío.
8. No asumir que `respuesta` siempre será `S` o `N`: en modo inteligente contiene texto.

## 10. Prueba mínima

```bash
curl --request POST "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --header "Content-Type: application/json" \
  --data '{
    "consulta": "¿Cómo creo un artículo?",
    "version": "5.00",
    "dominio": "CLIENTE_001",
    "usuario": "prueba"
  }'
```

Una integración correcta recibe HTTP `200` y JSON con `respuesta`, `fecha` y `vimeo_ids`.