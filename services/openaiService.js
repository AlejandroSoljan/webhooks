// services/openaiService.js
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function chatWithOpenAI(prompt) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("Error en OpenAI:", err);
    return "Lo siento, ocurrió un error al procesar tu mensaje.";
  }
}

module.exports = { chatWithOpenAI };
