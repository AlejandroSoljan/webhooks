# WhatsApp Webhook con OpenAI + MongoDB

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
