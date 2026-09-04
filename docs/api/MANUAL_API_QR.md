<!-- Asisto | Version: 5.00.021 | Fecha: 2026-09-04 -->
# Manual de integración - API pública QR de Asisto

## 1. Objetivo

La API QR presenta la ficha de un producto y permite iniciar una conversación asistida. La versión 5.00.021 prioriza la velocidad de respuesta: el primer turno usa únicamente datos confirmados del producto y no realiza una búsqueda web automática.

URL base:

```text
https://www.asistobot.com.ar
```

## 2. Flujo recomendado

1. El código QR abre `/qr/{tenant}?codigo={SKU}`.
2. La página consulta `/api/ext/qr/product` y muestra la ficha comercial.
3. Al tocar "Mostrar más info", `/api/ext/qr/chat` genera una respuesta breve sin buscar en Internet.
4. Las preguntas posteriores pueden usar búsqueda web solamente cuando necesitan información técnica externa.
5. El navegador actualiza el historial mediante `/api/ext/qr/chat/messages`.

Los precios y la disponibilidad siempre provienen de la API comercial configurada. La información de Internet no debe reemplazarlos.

## 3. Página pública QR

```http
GET /qr/{tenant}?codigo={SKU}
```

También se admite:

```http
GET /qr/{tenant}/{SKU}
```

Ejemplo:

```text
https://www.asistobot.com.ar/qr/RDV?codigo=12345
```

## 4. Consultar producto

```http
GET /api/ext/qr/product?tenant=RDV&codigo=12345
```

Respuesta abreviada:

```json
{
  "ok": true,
  "build": "2026-09-04-v6-fast-response",
  "tenant": "RDV",
  "currency": "ARS",
  "aiEnabled": true,
  "product": {
    "code": "12345",
    "description": "Producto de ejemplo",
    "price": 12500,
    "available": true,
    "image": "",
    "brand": "Marca",
    "category": "Categoría",
    "subcategory": "Subcategoría"
  }
}
```

Los productos se conservan en memoria durante cinco minutos por dominio y SKU. Esto reduce consultas repetidas a la API comercial.

## 5. Iniciar conversación rápida

```http
POST /api/ext/qr/chat
Content-Type: application/json
```

```json
{
  "tenant": "RDV",
  "codigo": "12345",
  "sessionId": "sesion_unica_del_navegador",
  "message": "",
  "initial": true
}
```

En el primer turno, `initial` debe ser `true`. La respuesta se genera con los datos confirmados del producto, sin búsqueda web automática.

Respuesta:

```json
{
  "ok": true,
  "conversationId": "68b000000000000000000000",
  "reply": "Respuesta breve sobre el producto.",
  "contactCaptured": false
}
```

## 6. Enviar una pregunta posterior

```json
{
  "tenant": "RDV",
  "codigo": "12345",
  "sessionId": "sesion_unica_del_navegador",
  "message": "¿Para qué trabajos se recomienda?",
  "initial": false
}
```

La búsqueda web permanece habilitada como acción opcional. Sólo se utiliza si la pregunta requiere información técnica o pública no disponible en la ficha ni en el historial.

Parámetros de rendimiento de la versión 5.00.021:

| Parámetro | Valor | Finalidad |
|---|---:|---|
| Caché de producto | 300000 ms | Evitar consultas comerciales repetidas. |
| Contexto web | `low` | Reducir tiempo y tokens de búsqueda. |
| Timeout web | 20000 ms | Evitar esperas prolongadas. |
| Timeout API de producto | 15000 ms | Fallar rápido si la fuente comercial no responde. |
| Máximo de salida web | 1200 tokens | Reducir procesamiento innecesario. |
| Máximo de contenido web | 5000 caracteres | Mantener acotado el contexto enviado a IA. |

## 7. Consultar mensajes

```http
GET /api/ext/qr/chat/messages?tenant=RDV&codigo=12345&sessionId=sesion_unica_del_navegador
```

Respuesta abreviada:

```json
{
  "ok": true,
  "conversationId": "68b000000000000000000000",
  "manualOpen": false,
  "items": [
    {
      "role": "assistant",
      "content": "Respuesta breve sobre el producto.",
      "createdAt": "2026-09-04T12:00:00.000Z",
      "fromOperator": false
    }
  ]
}
```

## 8. Errores habituales

| HTTP | Error | Motivo |
|---:|---|---|
| 400 | `tenant_codigo_required` | Faltan dominio o código de producto. |
| 400 | `message_required` | Falta el mensaje en un turno no inicial. |
| 404 | `qr_disabled` | La función QR no está habilitada. |
| 404 | `qr_ai_disabled` | El asistente QR no está habilitado. |
| 429 | `rate_limit` | Se superó el límite de consultas. |
| 500 | `qr_ai_failed` | No se pudo generar la respuesta. |
| 503 | `qr_api_not_configured` | No se configuró la API comercial. |

## 9. Medición de velocidad

El servidor registra el tiempo total de cada respuesta IA en los logs de Render:

```text
[qr] ai tenant=RDV sku=12345 conv=... ms=2450
```

Para comparar correctamente, probar el mismo producto y distinguir:

- Primera carga de producto sin caché.
- Carga repetida dentro de los cinco minutos.
- Primer turno de "Mostrar más info".
- Pregunta posterior que no necesita Internet.
- Pregunta técnica que sí activa búsqueda web.

## 10. Recomendaciones de integración

1. Mantener estable el `sessionId` durante la sesión del navegador.
2. Mostrar un indicador de escritura mientras `/api/ext/qr/chat` responde.
3. No reintentar automáticamente solicitudes de chat que aún estén en curso.
4. Tratar los timeouts como fallos recuperables y permitir reintento manual.
5. No usar información web para reemplazar precio, stock o disponibilidad comercial.
