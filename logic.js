// logic.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());


///Variables

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.1) || 0.1;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID.trim()
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v17.0";

//'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'; // Tu clave de API de OpenAI
//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
// Historial por número (almacenado en memoria)
const chatHistories = {};

/**
 * Procesa el mensaje y devuelve una respuesta de ChatGPT.
 */
async function getGPTReply(from, userMessage) {
  if (!chatHistories[from]) {
    chatHistories[from] = [
      { role: "system", content: "Eres un asistente de WhatsApp para la Rotisería Caryco. Cumple EXACTAMENTE estas reglas y formato. " +

"[IDENTIDAD Y TONO] " +
"- Estilo: amable, cordial y BREVE (WhatsApp). Frases cortas. " +
"- No compartas teléfono/dirección del local salvo que el cliente lo pida expresamente. " +

"[HORARIOS] " +
"- Abierto: Martes a Domingo. Lunes cerrado. " +
"- Entregas: 12:00–14:00 y 20:00–22:00. " +
"- Si el cliente pide Lunes o fuera de horario: indícalo brevemente y pedí otra franja válida (no confirmes). " +

"[ENTREGA] " +
"- Modalidades: retiro | domicilio. " +
"- Costo envío fijo: 1500. Se SUMA al total solo si modalidad = domicilio o si el cliente informó domicilio. " +
"- Si el cliente cambia a retiro: elimina domicilio y NO sumes envío. " +

"[DATOS OBLIGATORIOS] " +
"- Siempre debes recolectar: (1) productos con cantidades, (2) modalidad de entrega, (3) fecha y hora, (4) nombre y apellido; y si modalidad = domicilio, (5) domicilio. " +
"- Pedí la información que falte de a una cosa por vez (mensajes breves). " +

"[CATÁLOGO] (usa estos nombres y precios EXACTOS; no inventes otros productos) " +
"- Pollo entero (Pollo) .......... 30000 " +
"- Pollo mitad (Pollo) ........... 20000 " +
"- Papas para 2 personas (Papas).. 4000 " +
"- Papas para 4 personas (Papas).. 5000 " +
"- Papas para 6 personas (Papas).. 6000 " +
"- Ensalada lechuga (Ensaladas)... 3800 " +
"- Ensalada rúcula (Ensaladas).... 3900 " +
"- Ensalada tomates (Ensaladas)... 3800 " +
"- Si el cliente pide algo fuera del catálogo: notifícalo y ofrece alternativas del catálogo. " +

"[REGLAS DE CÁLCULO] (deterministas) " +
"- subtotal_item = cantidad * precio_unitario (del catálogo). " +
"- total_items = suma de todos los subtotales. " +
"- envio = 1500 si modalidad = domicilio o si se informó domicilio; en caso contrario 0. " +
"- total = total_items + envio. " +
"- Todos los importes deben ser decimales con punto y sin separadores (ej: 1000.00). " +
"- NO muestres “costo de envío” como línea separada en el texto conversacional; solo incorpóralo al total final. " +

"[CONFIRMACIÓN] " +
"- Cuando el cliente esté listo para confirmar, muestra un resumen breve en texto "}
    ];
  }
  chatHistories[from].push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: CHAT_MODEL,
        messages: chatHistories[from],
        temperature: CHAT_TEMPERATURE
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    chatHistories[from].push({ role: "assistant", content: reply });
    console.log("Historial:  "+ chatHistories[from]);

    return reply;
  } catch (error) {
    console.error("Error OpenAI:", error.response?.data || error.message);
    return "Lo siento, ocurrió un error. Intenta nuevamente.";
  }
}

/**
 * Envía mensaje por WhatsApp usando la Cloud API.
 */
async function sendWhatsAppMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Error enviando WhatsApp:", error.response?.data || error.message);
  }
}

// 📥 Endpoint para recibir mensajes entrantes de WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!entry || !entry.text) return res.sendStatus(200);

    const from = entry.from; // número de teléfono del usuario
    const text = entry.text.body;

    console.log(`📩 Mensaje recibido de ${from}: ${text}`);

    const gptReply = await getGPTReply(from, text);

    console.log(`🤖 Respuesta GPT: ${gptReply}`);

    await sendWhatsAppMessage(from, gptReply);

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook:", error.message);
    res.sendStatus(500);
  }
});

// 🔐 Verificación de Webhook de Meta (una sola vez)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("🟢 Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
