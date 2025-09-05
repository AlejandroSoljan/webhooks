// services/openaiService.js
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function chatWithOpenAI(prompt, { system = null, model = "gpt-4o-mini", temperature = 0.2 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: String(prompt || "") });
  try {
    const r = await client.chat.completions.create({ model, temperature, messages });
    const text = r.choices?.[0]?.message?.content || "";
    const usage = r.usage || null;
    return { text, usage, model };
  } catch (err) {
    console.error("OpenAI chat error:", err);
    return { text: "Lo siento, ocurrió un error al procesar tu mensaje.", usage: null, model };
  }
}

async function transcribeAudioBuffer(buffer, { filename = "audio.ogg", model = "gpt-4o-transcribe" } = {}) {
  try {
    const r = await client.audio.transcriptions.create({
      file: new File([buffer], filename),
      model
    });
    return { text: r.text || "", usage: r.usage || null, model };
  } catch (err) {
    console.error("OpenAI transcribe error:", err);
    return { text: "", usage: null, model };
  }
}

async function ocrImageFromUrl(imageUrl, { model = "gpt-4o-mini" } = {}) {
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Extraé texto legible de la imagen. Si no hay texto, describí brevemente lo que se ve." },
        { role: "user", content: [
          { type: "input_text", text: "Extrae el texto presente en esta imagen (OCR). Si hay varios bloques, listalos." },
          { type: "input_image", image_url: imageUrl }
        ] }
      ]
    });
    const text = r.choices?.[0]?.message?.content || "";
    const usage = r.usage || null;
    return { text, usage, model };
  } catch (err) {
    console.error("OpenAI OCR error:", err);
    return { text: "", usage: null, model };
  }
}

module.exports = { chatWithOpenAI, transcribeAudioBuffer, ocrImageFromUrl };
