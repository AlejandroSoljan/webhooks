# Asisto | Version: 5.00.049 | Fecha: 2026-09-08
# WhatsApp Webhook con OpenAI + MongoDB

## Módulo experimental: tickets desde WhatsApp

Diseño, alcance, migración y activación: [docs/whatsapp_support.md](docs/whatsapp_support.md).
Permanece desactivado por defecto. La primera vertical guarda borradores y aprobación local, sin escribir tickets en HubSpot.

## Variables de entorno necesarias
- `PORT` = puerto donde corre Express (ej. 3000)
- `VERIFY_TOKEN` = token de verificación de Webhook
- `WHATSAPP_TOKEN` = token de acceso de la API de WhatsApp Cloud
- `PHONE_NUMBER_ID` = ID del número de WhatsApp
- `OPENAI_API_KEY` = API Key de OpenAI
- `MONGODB_URI` = cadena de conexión a MongoDB

## Cómo correr
```bash
npm install
npm run dev   # con nodemon
npm start     # producción
```
