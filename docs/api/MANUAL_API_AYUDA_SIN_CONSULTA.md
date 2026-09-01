<!-- Asisto | Version: 5.00.011 | Fecha: 2026-09-01 -->
# API de Ayuda contextual — modo sin consulta inteligente

## 1. Objetivo

Este modo devuelve videos de ayuda relacionados con la ventana actual de Manager. No recibe una pregunta del usuario y no utiliza el campo `consulta`.

La selección se realiza usando:

- El nombre técnico de la ventana.
- La versión de Manager.
- La configuración de ayuda disponible para el agente.

Endpoint:

```text
https://www.asistobot.com.ar/api/ext/ayuda
```

Métodos admitidos: `GET` y `POST`.

## 2. Autenticación

Enviar la clave en el encabezado `X-API-Key`:

```http
X-API-Key: SU_CLAVE_API
```

También se admiten:

```http
Authorization: Bearer SU_CLAVE_API
X-Asisto-Key: SU_CLAVE_API
```

La clave debe permanecer en el backend. No debe incluirse en código ejecutado por el navegador, repositorios, URLs ni logs.

## 3. Parámetros

| Parámetro | Obligatorio | Descripción |
|---|---:|---|
| `agente` | No | Agente de ayuda. Si se omite, se utiliza `MANAGER`. |
| `ventana` | Sí | Nombre técnico de la ventana actual de Manager. |
| `version` | Sí | Versión de Manager utilizada para filtrar los videos aplicables. |
| `dominio` | Sí | Dominio del cliente que origina la solicitud. |
| `usuario` | Sí | Identificador del usuario que solicita la ayuda. |

En este modo **no debe enviarse `consulta`**.

Ejemplo de datos:

```json
{
  "agente": "MANAGER",
  "ventana": "w_pro_abm_productos",
  "version": "5.00",
  "dominio": "CLIENTE_001",
  "usuario": "operador01"
}
```

## 4. Solicitud mediante POST

```bash
curl --request POST "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --header "Content-Type: application/json" \
  --data '{
    "agente": "MANAGER",
    "ventana": "w_pro_abm_productos",
    "version": "5.00",
    "dominio": "CLIENTE_001",
    "usuario": "operador01"
  }'
```

## 5. Solicitud mediante GET

```bash
curl --get "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --data-urlencode "agente=MANAGER" \
  --data-urlencode "ventana=w_pro_abm_productos" \
  --data-urlencode "version=5.00" \
  --data-urlencode "dominio=CLIENTE_001" \
  --data-urlencode "usuario=operador01"
```

## 6. Respuesta con videos

Cuando existen videos aplicables, `respuesta` contiene `S`:

```json
{
  "respuesta": "S",
  "fecha": "2026-08-29T20:15:00",
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

Los videos se ordenan por `importancia`: `1` es la prioridad más alta. Los valores `0` o vacíos quedan al final. El campo `caratula` contiene el valor leído desde la columna `Caratula` o `Carátula` de Drive y puede ser una cadena vacía.

Aunque el campo se llama `vimeo_ids`, contiene objetos completos con los datos de cada video.

## 7. Respuesta sin videos

Cuando no existen videos aplicables, `respuesta` contiene `N`:

```json
{
  "respuesta": "N",
  "fecha": "2026-08-29T20:15:00",
  "vimeo_ids": []
}
```

`N` no representa un error. Indica que no se encontró contenido compatible con la ventana y versión enviadas.

## 8. Ejemplo en JavaScript para backend

```javascript
async function obtenerAyudaContextual({ apiKey, ventana, version, dominio, usuario }) {
  const response = await fetch('https://www.asistobot.com.ar/api/ext/ayuda', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({
      agente: 'MANAGER',
      ventana,
      version,
      dominio,
      usuario
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Error HTTP ${response.status}`);
  }

  return {
    encontrado: data.respuesta === 'S',
    fecha: data.fecha,
    videos: Array.isArray(data.vimeo_ids) ? data.vimeo_ids : []
  };
}
```

## 9. Errores

| HTTP | Error | Motivo |
|---:|---|---|
| `400` | `ventana_required` | Falta `ventana`. |
| `400` | `version_required` | Falta `version`. |
| `400` | `dominio_required` | Falta `dominio`. |
| `400` | `usuario_required` | Falta `usuario`. |
| `401` | `unauthorized` | La clave es incorrecta o no fue enviada. |
| `500` | Error interno | Se produjo un fallo inesperado. |
| `502` | Error de fuente | No se pudo consultar la fuente de ayuda. |
| `503` | Configuración faltante | Falta una dependencia requerida por el servicio. |

Ejemplo:

```json
{
  "ok": false,
  "error": "ventana_required"
}
```

## 10. Flujo recomendado

1. Manager abre una ventana.
2. El backend obtiene su nombre técnico y la versión actual.
3. El backend llama al API sin enviar `consulta`.
4. Si `respuesta` es `S`, muestra los videos recibidos.
5. Si `respuesta` es `N`, oculta la opción de videos o informa que no hay ayuda disponible.
6. Si el estado HTTP no es `200`, aplica el manejo de errores correspondiente.

## 11. Prueba mínima

```bash
curl --request POST "https://www.asistobot.com.ar/api/ext/ayuda" \
  --header "X-API-Key: SU_CLAVE_API" \
  --header "Content-Type: application/json" \
  --data '{
    "ventana": "w_pro_abm_productos",
    "version": "5.00",
    "dominio": "CLIENTE_001",
    "usuario": "prueba"
  }'
```

Una integración correcta recibe HTTP `200` y un JSON con `respuesta`, `fecha` y `vimeo_ids`.