Estructura generada por split:
- server.js
- routes/
  - webhook.js
  - admin.js
  - behavior.js
- services/
  - webhookService.js
  - whatsappService.js
  - openaiService.js
  - mediaService.js
  - sheetsService.js
  - behaviorService.js
  - adminService.js
  - mongoService.js

Variables de entorno requeridas (ejemplos):
- PORT=3000
- VERIFY_TOKEN=...
- WHATSAPP_TOKEN=...
- WHATSAPP_PHONE_NUMBER_ID=...
- WHATSAPP_APP_SECRET=... (opcional para validar firma)
- GRAPH_VERSION=v22.0
- OPENAI_API_KEY=...
- OPENAI_CHAT_MODEL=gpt-4o-mini
- OPENAI_TEMPERATURE=0.2
- TTS_MODEL=gpt-4o-mini-tts
- TTS_VOICE=alloy
- TTS_FORMAT=mp3
- TRANSCRIBE_API_URL=https://...
- GOOGLE_SERVICE_ACCOUNT_EMAIL=...
- GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
- GOOGLE_SHEETS_ID=https://docs.google.com/spreadsheets/d/XXXXX/edit
- BEHAVIOR_SOURCE=sheet|env|mongo
- COMPORTAMIENTO="texto..." (si BEHAVIOR_SOURCE=env)
- MONGODB_URI=mongodb+srv://user:pass@host/db
- DB_NAME=app
- BUSINESS_NAME=NEGOCIO
- BUSINESS_ADDRESS=...
- BUSINESS_PHONE=...

Para ejecutar:
1) npm i express dotenv openai googleapis mongodb node-fetch@2
2) node server.js
