<!-- Asisto | Version: 5.00.149 | Fecha: 2026-09-17 -->
# Costo interno de tickets WhatsApp para ALSO

El panel `Control de Consumos` recalcula el **costo real** desde `ai_token_usage_log` en cada consulta; no hay que modificar registros históricos. Solo se aplican estas tarifas a eventos `message` del canal `whatsapp_tasks` y dominio `ALSO`. No alteran la tarifa comercial (`token_charge_*`) ni los consumos de otros dominios.

Variables de entorno (USD por 1.000 tokens):

```env
TOKEN_COST_TASKS_WS_MODEL=gpt-5.4
TOKEN_COST_TASKS_WS_INPUT_PER_1K=0.0025
TOKEN_COST_TASKS_WS_OUTPUT_PER_1K=0.015
TOKEN_COST_TASKS_WS_LUNA_INPUT_PER_1K=0.0002
TOKEN_COST_TASKS_WS_LUNA_OUTPUT_PER_1K=0.0012
TOKEN_COST_WHISPER_PER_MINUTE=0.006
```

Los valores anteriores son los predeterminados del código. Cambiar una variable y reiniciar el servidor recalcula el historial en el panel. La selección usa el modelo registrado en cada evento, no supone que todos los eventos de la clave usaron el mismo modelo.

`whisper-1` se cobra por minuto, no por token. En las transcripciones nuevas se guardan los segundos del audio y `costUsd` por llamada en `ai_token_usage_log`, además del costo en `support_usage`. El panel suma ese costo al costo real; no lo incluye en las tarifas comerciales del cliente. El costo es una estimación proporcional a los segundos informados por WhatsApp, no una factura emitida por OpenAI. El script `scripts/backfill_also_whisper_cost.js` completa registros históricos de ALSO que tienen duración y una transcripción exitosa correspondiente; sin `--apply` solo informa el plan.

No se descuenta el caché de entrada del análisis de texto: el registro actual no conserva esos tokens. Para conciliar exactamente con la factura de OpenAI hay que comparar el mismo rango de fechas y clave.
