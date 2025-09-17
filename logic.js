// logic.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 🔐 Reemplaza con tus tokens reales
const WHATSAPP_TOKEN = 'EAAOlXEb393oBPHtpnFvgynk7k1Tg6tuVW7wtguIHkU3sfWGT9b0epaGKnDeJ59UvEZBlUdmcZBhGXs8qkkPfCla5wFEP0U7hLtsh6eAABUQRE1kr4UYHDkoaTurrmZAkSZBc6UY9iS2l0W7EleZAvhO7m30Bh51BBNXa46aqyqg4Ex8hA6d8ZCZBP3y4TZAC5X8YxAZDZD'; // Token de acceso de WhatsApp Cloud API
const VERIFY_TOKEN = 'aleds5200'; // Token para verificación del webhook
const PHONE_NUMBER_ID = '764414663425868'; // ID del número de teléfono de WhatsApp
const OPENAI_API_KEY = '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'; // Tu clave de API de OpenAI
//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
// Historial por número (almacenado en memoria)
const chatHistories = {};

/**
 * Procesa el mensaje y devuelve una respuesta de ChatGPT.
 */
async function getGPTReply(from, userMessage) {
  if (!chatHistories[from]) {
    chatHistories[from] = [
      { role: "system", content: "PERFIL Asistente que toma pedidos de la Rotisería Caryco "+
"CONTACTO "+
"Se encuentra ubicada en Mitre y Alvear. Telefono es 434868. Brindar solo si es necesaria o el cliente lo solicita "+
"DIAS Y HORARIOS DE ENTREGA "+
"DIAS Y HORARIOS DE ENTREGA "+
"Abierto de Martes a Domingo (Lunes cerrado). Mediodia de 12:00 a 14:00 y por la noche de 20:00 a 22:00. "+
"TONO DE CONVERSACIÓN  "+
"Estilo: amable, cordial, breve para interactuar con el cliente por WhatsApp. Usar la menor cantidad de palabras. "+
"FORMAS DE ENTREGA "+
"Retiro en local. "+
"Entrega a domicilio. Tiene un costo de 1500. No debes detallar el costo al cliente, pero si sumar al total del pedido. Debes solicitar el domicilio al cliente. "+
"FORMAS DE PAGO "+
"Retiro en local: efectivo, débito, transferencia "+
"Envío a domicilio: efectivo "+
"PROCESO DE TOMA DE PEDIDO "+
"Ofrecerle Pollo, Papas, Milanesas, Empanadas, Ensaladas, Bebidas.  "+
"Interactuar amablemente con el cliente hasta reunir la información de los productos del catalogo que quiere, forma de entrega, fecha y hora de entrega, nombre y apellido. Debes solicitar todos estos datos si o si y mostrar el PEDIDO CONFIRMADO. "+
"PEDIDO CONFIRMADO "+
"Para confirmar el pedido debe mostrarse al cliente los siguientes datos y que el cliente escriba la palabra CONFIRMAR "+
"Pedido: listar los productos pedidos por el clientes uno abajo del otro, ten en cuenta que puede solicitar mas de una unidad de cada uno.  El precio total lo debes calcular multiplicando la cantidad por el precio del catálogo. El cliente solo puede pedir los productos existentes en el CATALOGO. "+
"forma de entrega: mostrar opción seleccionada por el cliente, y domicilio si el cliente selecciona la opción Envío a domicilio. "+
"Fecha y hora de entrega: mostrar la fecha y hora de entrega proporcionada por el cliente. Ten en cuenta que los lunes no esta abierta la rotisería. "+
"Nombre y Apellido: nombre y apellido proporcionado por el cliente. "+
"Total: debes sumar los productos y envío (si se envía a domicilio). debe ser numero decimal sin símbolo ni separadores de miles, usar punto como separador (ej: 1000.50) . mostrar al final cuando el cliente tenga que confirmar. No delires ya que debe ser exacto y muestra solo el TOTAL que debe pagar el cliente.  "+
"[CATALOGO] "+
"Pollo entero. Categoria: Pollo. Precio: 30000. Observaciones: solicitar si lo quiere con chimi, limon o solo. "+
"Pollo mitad. Categoria: Pollo. Precio: 20000. Observaciones: solicitar si lo quiere con chimi, limon o solo. "+
"Papas para 2 personas. Categoria: Papas Fritas. Precio: 4000. Observaciones: se vende por porción. "+
"Papas para 4 personas. Categoria: Papas Fritas. Precio: 5000. Observaciones: se vende por porción. "+
"Papas para 6 personas. Categoria: Papas Fritas. Precio: 6000. Observaciones: se vende por porción. "+
"Ensalada lechuga. Categoria: Ensaladas. Precio: 3800. Observaciones: se vende por bandeja. "+
"Ensalada rúcula.  Categoria: Ensaladas. Precio: 3900. Observaciones: se vende por bandeja. "+
"Ensalada tomates.  Categoria: Ensaladas. Precio: 3800. Observaciones: se vende por bandeja. "+
"Simulemos que Hoy es Lunes 15/09/2025" }
    ];
  }

  chatHistories[from].push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: chatHistories[from],
        temperature: 0.2
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
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
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
