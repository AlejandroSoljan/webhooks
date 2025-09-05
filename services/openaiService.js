// services/openaiService.js
const crypto = require("crypto");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE)
  : 0.2;

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms)
    )
  ]);
}

// JSON helpers
function coerceJsonString(raw) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.replace(/^\uFEFF/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ").trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(\w+)?/i, "").replace(/```$/i, "").trim();
  }
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s;
}

async function safeJsonParseStrictOrFix(raw) {
  let s = coerceJsonString(raw);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {}
  try {
    const fix = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Devuelve EXCLUSIVAMENTE un JSON válido, sin comentarios ni markdown." },
        { role: "user", content: `Convertí lo siguiente a JSON estricto (si falta llaves, completalas):\n\n${raw}` }
      ]
    });
    const fixed = fix.choices?.[0]?.message?.content || "";
    const fixedClean = coerceJsonString(fixed);
    return JSON.parse(fixedClean);
  } catch (e2) {
    try { return JSON.parse(s); } catch (e3) { return null; }
  }
}

async function transcribeImageWithOpenAI(publicImageUrl) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: "o4-mini",
    messages: [
      { role: "system", content: "Muestra solo el texto sin saltos de linea ni caracteres especiales que veas en la imagen" },
      { role: "user", content: [{ type: "image_url", image_url: { url: publicImageUrl } }] }
    ],
    temperature: 1
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision error: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function synthesizeTTS(text) {
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";
  const format = (process.env.TTS_FORMAT || "mp3").toLowerCase();

  const resp = await openai.audio.speech.create({ model, voice, input: text, format });
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mime =
    format === "wav" ? "audio/wav" :
    format === "opus" ? "audio/ogg" :
    "audio/mpeg";
  return { buffer, mime };
}

// OpenAI chat call with retries
async function openaiChatWithRetries(messages, { model = CHAT_MODEL, temperature = CHAT_TEMPERATURE } = {}) {
  const maxRetries = parseInt(process.env.OPENAI_RETRY_COUNT || "2", 10);
  const baseDelay  = parseInt(process.env.OPENAI_RETRY_BASE_MS || "600", 10);
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(
        openai.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          temperature,
          top_p: 1,
          messages
        }),
        parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10),
        "openai_chat"
      );
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) ? e.message : String(e);
      const retriable = /timeout/i.test(msg) || e?.status === 429 || e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET";
      if (attempt < maxRetries && retriable) {
        const jitter = Math.floor(Math.random() * 250);
        const delay = baseDelay * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("openai_chat_failed");
}

module.exports = {
  openai,
  CHAT_MODEL,
  CHAT_TEMPERATURE,
  withTimeout,
  safeJsonParseStrictOrFix,
  transcribeImageWithOpenAI,
  synthesizeTTS,
  openaiChatWithRetries,
};
