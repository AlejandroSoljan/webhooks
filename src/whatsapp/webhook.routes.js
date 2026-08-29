// Asisto | Version: 5.00.001 | Fecha: 2026-08-29
// src/whatsapp/webhook.routes.js
// Webhook de WhatsApp (verify + mensajes).
// Código movido 1:1 desde endpoint.js para separar la capa WhatsApp.
// IMPORTANTÍSIMO: no cambia funcionalidad.

module.exports = function mountWebhookRoutes(app, ctx) {
  const {
    VERIFY_TOKEN,
    DEFAULT_TENANT_ID,
    TENANT_ID,
    // runtime
    findAnyByVerifyToken,
    getRuntimeByPhoneNumberId,
    // seguridad
    isValidSignature,
    // deps
    getDb,
    ObjectId,
    // funciones de persistencia (definidas en endpoint)
    upsertConversation,
    saveMessageDoc,
    closeConversation,
    saveLog,

    // logic.js
    putInCache,
    getMediaInfo,
    downloadMediaBuffer,
    transcribeAudioExternal,
    analyzeImageExternal,
    getGPTReply,
    syncSessionConversation,
    isPoliteClosingMessage,
    clearEndedFlag,
    hasActiveEndedFlag,
    markSessionEnded,
    recalcAndDetectMismatch,
    ensureEnvioSmart,
    hydratePricesFromCatalog,
    buildBackendSummary,
    coalesceResponse,
    START_FALLBACK,
    setAssistantPedidoSnapshot,
    hasContext,
    sendWhatsAppMessage,
  } = ctx;

// Webhook Verify (GET)
// Retrocompatible: acepta VERIFY_TOKEN de .env como siempre,
// y además acepta cualquier verifyToken guardado en tenant_channels.
app.get("/webhook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];

  if (!mode || mode !== "subscribe" || !token) return res.sendStatus(403);

  // 1) modo legacy (solo .env)
  if (token && token === String(VERIFY_TOKEN || "").trim()) {
    return res.status(200).send(challenge);
  }

  // 2) modo multi-tenant (DB)
  try {
    const rt = await findAnyByVerifyToken(token);
    if (rt) return res.status(200).send(challenge);
  } catch (e) {
    console.error("[webhook] verify db error:", e?.message || e);
  }

  return res.sendStatus(403);
});

// Webhook Entrante (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      if (process.env.NODE_ENV === "production") return res.sendStatus(403);
      console.warn("⚠️ Webhook: firma inválida (ignorada en dev).");
    }
// ✅ PARSEO CORRECTO DEL PAYLOAD WHATSAPP

    const change = req.body?.entry?.[0]?.changes?.[0];
    const value  = change?.value;
const phoneNumberIdInbound =
  value?.metadata?.phone_number_id ||
  value?.metadata?.phoneNumberId ||
  value?.metadata?.phone_number ||
  null;

// Runtime por canal (WhatsApp/OpenAI) desde Mongo.
// Si no existe, cae a .env (100% retrocompatible).
let runtime = null;
try { runtime = await getRuntimeByPhoneNumberId(phoneNumberIdInbound); } catch {}
const tenant = String(runtime?.tenantId || DEFAULT_TENANT_ID || TENANT_ID || "default").trim();

const waOpts = {
  whatsappToken: runtime?.whatsappToken || null,
  phoneNumberId: runtime?.phoneNumberId || phoneNumberIdInbound || null,
};
const aiOpts = { openaiApiKey: runtime?.openaiApiKey || null };

    const msg    = value?.messages?.[0];   // mensaje entrante (texto/audio/etc.)
    const status = value?.statuses?.[0];   // (se ignora para persistencia)
    if (!msg) {
      console.warn("[webhook] evento sin messages; se ignora");
      return res.sendStatus(200);
    }
    const from = msg.from;
    let text   = (msg.text?.body || "").trim();
    const msgType = msg.type;

    // Normalización del texto según tipo de mensaje
    if (msg.type === "text" && msg.text?.body) {
      text = msg.text.body;
    } else if (msg.type === "audio" && msg.audio?.id) {
      try {
        const info = await getMediaInfo(msg.audio.id, waOpts);
        const buf = await downloadMediaBuffer(info.url, waOpts);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type, ...aiOpts });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
      } catch (e) {
        console.error("Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
     } else if (msg.type === "image" && msg.image?.id) {
      try {
        const info = await getMediaInfo(msg.image.id, waOpts);
        const buf = await downloadMediaBuffer(info.url, waOpts);
        const id = putInCache(buf, info.mime_type || "image/jpeg");
        const publicImageUrl = `${req.protocol}://${req.get("host")}/cache/media/${id}`;

        const img = await analyzeImageExternal({
          publicImageUrl,
          mime: info.mime_type,
          purpose: "payment-proof",
          ...aiOpts
        });

        // Texto que alimenta al modelo conversacional
        text = img?.userText || "[imagen recibida]";

        // enriquecemos meta para admin/debug
        msg.__media = { cacheId: id, publicUrl: publicImageUrl, mime: info.mime_type, analysis: img?.json || null };
      } catch (e) {
        console.error("Imagen/análisis:", e?.message || e);
        text = "[imagen recibida]";
      }
    }

        // Asegurar conversación y guardar mensaje de usuario
    let conv = null;
    try { conv = await upsertConversation(from, {}, tenant); } catch (e) { console.error("upsertConversation:", e?.message); }
    const convId = conv?._id;

   
console.log("[convId] "+ convId);

    // ✅ Si se creó una conversación nueva, reseteamos historial del LLM
    // para que un nuevo pedido no arrastre contexto del pedido anterior.
    if (convId) syncSessionConversation(tenant, from, convId);

       if (convId) {
      console.log("[messages] about to save USER message", { convId, from, type: msg.type, textPreview: String(text).slice(0,80) });
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "user",
          content: text,
          type: msg.type || "text",
           meta: { raw: msg, media: msg.__media || null }
        });
      } catch (e) { console.error("saveMessage(user):", e?.message); }
    }

    // 🧑‍💻 Si la conversación está en modo manual, no respondemos automáticamente
    if (conv && conv.manualOpen) {
      console.log("[webhook] conversación en modo manualOpen=true; se omite respuesta automática.");
      return res.sendStatus(200);
   }


    // Si el mensaje NO es solo un cierre de cortesía, limpiamos el flag de sesión terminada
    if (!isPoliteClosingMessage(text)) {
      clearEndedFlag(tenant, from);
    }

    if (hasActiveEndedFlag(tenant, from)) {
      if (isPoliteClosingMessage(text)) {
        await sendWhatsAppMessage(
          from,
          "¡Gracias! 😊 Cuando quieras hacemos otro pedido.",
          waOpts
        );
        return res.sendStatus(200);
      }
    }

        // ⚡ Fast-path: si el usuario confirma explícitamente, cerramos sin llamar al modelo
    // ⚡ Fast-path: aceptar también “sí/si” como confirmación explícita,
    // además de las variantes de “confirmar”.
    const userConfirms =
      /\bconfirm(ar|o|a|ame|alo|ado)\b/i.test(text) ||
      /\b(s[ií])\b/.test(text);
    if (userConfirms) {
      // Tomamos último snapshot si existe
      let snapshot = null;
      try { snapshot = JSON.parse("{}"); } catch {}
      // En minimal guardamos snapshot siempre; si no lo tenés a mano, seguimos y dejamos que el modelo lo complete
    }
    const gptReply = await getGPTReply(tenant, from, text, aiOpts);
    // También dispara si el usuario pide "total" o está en fase de confirmar
   const wantsDetail = /\b(detalle|detall|resumen|desglose|total|confirm(a|o|ar))\b/i
      .test(String(text || ""));


    let responseText = "Perdón, hubo un error. ¿Podés repetir?";
    let estado = null;
    let pedido = null;

    try {
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = parsed.Pedido || { items: [] };
      // 💰 Hidratar precios desde catálogo ANTES de recalcular (evita “Pollo entero @ 0”)
      try { pedido = await hydratePricesFromCatalog(pedido, tenant || null); } catch {}
      // 🚚 Asegurar ítem Envío con geocoding/distancia (awaitable, sin race)
      try { pedido = await ensureEnvioSmart(pedido, tenant || null); } catch {}

      // 🧽 Normalización defensiva: si el modelo puso la HORA en `Entrega`, corrige campos.
      if (pedido && typeof pedido.Entrega === "string" && /^\d{1,2}:\d{2}$/.test(pedido.Entrega)) {
        const hhmm = pedido.Entrega.length === 4 ? ("0" + pedido.Entrega) : pedido.Entrega;
        pedido.Hora = pedido.Hora || hhmm;
        // Si `Entrega` no es "domicilio" ni "retiro", dejalo vacío para que no bloquee isPedidoCompleto
        if (!/^(domicilio|retiro)$/i.test(pedido.Entrega)) pedido.Entrega = "";
      }

      const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido);
      pedido = pedidoCorr;

      //if (mismatch && hasItems) {
      //  let fixedOk = false;
      //  let parsedFixLast = null;

       // ✅ Si el modelo devuelve {"error":"..."} lo tratamos como MENSAJE AL USUARIO (no fatal):
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        responseText = parsed.error.trim();
      } else if (mismatch && hasItems) {
        let fixedOk = false;
        let parsedFixLast = null;

        const itemsForModel = (pedido.items || [])
          .map(i => `- ${i.cantidad} x ${i.descripcion} @ ${i.importe_unitario}`)
          .join("\n");

        const baseCorrection = [
          "[CORRECCION_DE_IMPORTES]",
          "Detectamos que los importes de tu JSON no coinciden con la suma de ítems según el catálogo.",
          "Usá EXACTAMENTE estos ítems interpretados por backend (cantidad y precio unitario):",
          itemsForModel,
          `Total esperado por backend (total_pedido): ${pedido.total_pedido}`,
          "Reglas OBLIGATORIAS:",
          "- Recalculá todo DESDE CERO usando esos precios (no arrastres totales previos).",
          "- Si Pedido.Entrega = 'domicilio', DEBES incluir el ítem de Envío correspondiente.",
          "",
          "SOBRE EL CAMPO response:",
          "- NO digas que estás recalculando ni hables de backend ni de importes.",
          "- Usá en `response` el MISMO tipo de mensaje que venías usando para seguir la conversación.",
          "- Si antes estabas pidiendo fecha y hora, seguí pidiendo fecha y hora.",
          "- Si ya tenés fecha/hora, seguí con el siguiente dato faltante (por ejemplo, nombre del cliente).",
          "",
          "Devolvé UN ÚNICO objeto JSON con: response, estado (IN_PROGRESS|COMPLETED|CANCELLED),",
          "y Pedido { Entrega, Domicilio, items[ {id, descripcion, cantidad, importe_unitario, total} ], total_pedido }.",
          "No incluyas texto fuera del JSON."
        ].join("\n");

        for (let attempt = 1; attempt <= (Number(process.env.CALC_FIX_MAX_RETRIES || 3)); attempt++) {
          const fixReply = await getGPTReply(tenant, from, `${baseCorrection}\n[INTENTO:${attempt}/${process.env.CALC_FIX_MAX_RETRIES || 3}]`, aiOpts);
          console.log(`[fix][${attempt}] assistant.content =>\n${fixReply}`);
          try {
            const parsedFix = JSON.parse(fixReply);
            parsedFixLast = parsedFix;
            estado = parsedFix.estado || estado;

            let pedidoFix = parsedFix.Pedido || { items: [] };
             // 💰 Rehidratar también en el ciclo de fix
            try { pedidoFix = await hydratePricesFromCatalog(pedidoFix, tenant || null); } catch {}
         
            const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } = recalcAndDetectMismatch(pedidoFix);
            pedido = pedidoFixCorr;

            if (!mismatchFix && hasItemsFix) { fixedOk = true; break; }
          } catch (e2) {
            console.error("Error parse fixReply JSON:", e2.message);
          }
        }

        responseText =
          parsedFixLast && typeof parsedFixLast.response === "string"
            ? coalesceResponse(parsedFixLast.response, pedido)
            // Solo mostrar resumen si el usuario pidió detalle/total/confirmar
            : (wantsDetail ? buildBackendSummary(pedido, { showEnvio: wantsDetail }) : "");
      } else {
        responseText = coalesceResponse(parsed.response, pedido);
      }
    } catch (e) {
      console.error("Error al parsear/corregir JSON:", e.message);
    }

    // ✅ Validar día y horario del pedido contra los horarios configurados del local
    try {
      // Normalizar campos de fecha/hora desde el JSON del modelo.
      // El asistente devuelve fecha_pedido / hora_pedido, pero la validación
      // trabaja con Pedido.Fecha / Pedido.Hora.
      if (pedido && typeof pedido === "object") {
        if (!pedido.Fecha &&
            typeof pedido.fecha_pedido === "string" &&
            pedido.fecha_pedido.trim()) {
          pedido.Fecha = pedido.fecha_pedido.trim();
        }
        if (!pedido.Hora &&
            typeof pedido.hora_pedido === "string" &&
            pedido.hora_pedido.trim()) {
          pedido.Hora = pedido.hora_pedido.trim();
        }
      }

      if (pedido && typeof pedido === "object" && pedido.Fecha && pedido.Hora) {
        const db = await getDb();
        const hoursDocId = `store_hours:${tenant}`;
        const docHours = await db.collection("settings").findOne({ _id: hoursDocId });
        const hoursCfg = docHours?.hours || null;

        if (hoursCfg) {
          const schedCheck = validatePedidoSchedule(pedido, hoursCfg);
          if (!schedCheck.ok) {
            // Si la fecha/hora no es válida, sobreescribimos la respuesta textual
            // para que el usuario elija un nuevo horario dentro de las franjas.
            responseText = schedCheck.msg;
            // Si ya estaba en COMPLETED, lo bajamos a IN_PROGRESS para que siga el flujo
            if (estado === "COMPLETED") {
              estado = "IN_PROGRESS";
            }
          }
        }
      }
    } catch (e) {
      console.error("[hours] Error al validar fecha/hora de Pedido:", e?.message || e);
    }
     /*// Guardar respuesta del asistente:
     // 1) el TEXTO que se envía al cliente
     // 2) un SNAPSHOT JSON con el Pedido ya corregido, para que /admin pueda leerlo
     if (convId) {
       try {
         console.log("[messages] about to save ASSISTANT message", { convId: String(convId), from, len: String(responseText||"").length });
         await saveMessageDoc({
           tenantId: tenant,
           conversationId: convId,
           waId: from,
           role: "assistant",
           content: String(responseText || ""),
           type: "text",
          meta: { model: "gpt" }
         });
       } catch (e) {
         console.error("saveMessage(assistant text):", e?.message);
       }
 
       // Preparar el snapshot JSON a persistir (usa el pedido ya armado en este handler)
       try {
         const snap = {
           response: typeof responseText === "string" ? responseText : "",
           estado: typeof estado === "string" ? estado : "IN_PROGRESS",
           Pedido: pedido && typeof pedido === "object"
             ? pedido
             : { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 }
         };
         const assistantSnapshot = JSON.stringify(snap);
         await saveMessageDoc({
           tenantId: tenant,
           conversationId: convId,
           waId: from,
           role: "assistant",
           content: assistantSnapshot,
           type: "json",
           meta: { model: "gpt", kind: "pedido-snapshot" }
         });
       } catch (e) {
         console.error("saveMessage(assistant json):", e?.message);
       }
     }
*/
    try {
      let finalBody = String(responseText ?? "").trim();

      // 🛡️ Si el modelo solo respondió algo muy corto tipo
      // "tu pedido queda así" sin detallar productos/total,
      // generamos un resumen completo desde backend.
      if (
        finalBody &&
        /queda\s+as[ií]/i.test(finalBody) &&
        finalBody.length < 80 &&
        pedido &&
        Array.isArray(pedido.items) &&
        pedido.items.length > 0
      ) {
        // Usamos el resumen estándar del backend (sin ítem de envío)
        responseText = buildBackendSummary(pedido);
        finalBody = String(responseText || "").trim();
      }

      if (!finalBody) {
        // No forzar resumen a menos que lo pidan explícitamente
        if (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length > 0) {
          responseText = buildBackendSummary(pedido, { showEnvio: wantsDetail });
        } else {
          // Texto neutro si ya hay contexto; saludo solo si no lo hay
          responseText = coalesceResponse("", pedido);
        }
      }
    } catch {}


    /*// 🚚 Visibilidad de "Envío": sólo en total/resumen/confirmación
    // (o cuando wantsDetail=true). En resúmenes parciales lo ocultamos.
    try {
      const text = String(responseText || "");
      const showsTotals = /\btotal\s*:?\s*\d/i.test(text);
      const isConfirmation = /¿\s*confirm/i.test(text) || /\u00BF\s*confirm/i.test(text) || /¿Confirmas\?/i.test(text);
      const explicitResumen = /resumen del pedido/i.test(text);
      const allowShipping = wantsDetail || showsTotals || isConfirmation || explicitResumen;
      if (!allowShipping) {
        // Remover líneas que muestren "Envío ..." (con o sin viñetas)
        responseText = text
          .split(/\r?\n/)
          .filter(line =>
            !/^\s*[-•*]\s*Env[ií]o\b/i.test(line) &&  // • Envío ...
            !/^\s*Env[ií]o\b/i.test(line)            // Envío ...
          )
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    } catch {}*/


    // 🔎 Leyenda de milanesas: mostrarla SOLO en resumen/total/confirmar.
    // Si el modelo generó un resumen aunque el usuario no haya pedido "total/resumen",
    // lo detectamos por el contenido del responseText.
    try {
      const hasMilanesas = (pedido?.items || []).some(i =>
        String(i?.descripcion || "").toLowerCase().includes("milanesa")
      );
      // ¿El texto "parece" un resumen?
      const looksLikeSummary = wantsDetail || /\b(resumen del pedido|total\s*:|\btotal\b|¿\s*confirm|¿confirmas|\u00BF\s*confirm)/i.test(String(responseText || ""));

      if (!hasMilanesas) {
        // Limpia cualquier rastro de la leyenda si no hay milanesas
        responseText = String(responseText || "")
          .replace(/\*?\s*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega\.\s*\*?/i, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      } else {
        if (looksLikeSummary) {
          // Asegurar que la leyenda esté presente en resúmenes/totales/confirmaciones
          const hasLegend = /\bse pesan al entregar\b/i.test(String(responseText || ""));
          if (!hasLegend) {
            responseText = `${String(responseText || "").trim()}\n\n*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.*`;
          }
        } else {
          // No es resumen → quitar la leyenda si el modelo la hubiera puesto
          responseText = String(responseText || "")
            .replace(/\*?\s*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega\.\s*\*?/i, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
      }
    } catch {}

    /*await sendWhatsAppMessage(from, responseText);
    // persistir respuesta del asistente
    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: responseText,
          type: "text"
        });
      } catch (e) { console.error("saveMessage(assistant):", e?.message); }
    }*/

    //await sendWhatsAppMessage(from, responseText);
    // ⚠️ No persistimos aquí para evitar duplicados.
    // El guardado del mensaje del asistente (texto) y del snapshot JSON
    // se realiza más abajo en un único bloque.
    // 1) Enviar EXACTAMENTE el texto final (post-fallback/normalizaciones)
    //await sendWhatsAppMessage(from, responseText);
        // 1) Enviar EXACTAMENTE el texto final (post-fallback/normalizaciones)
    //    ⚠️ Garantía: nunca mandar vacío a WhatsApp


    // ==============================
    // ✅ Validación de dirección exacta (Google Maps)
    // Si el geocoding NO es exacto, pedimos al cliente que reescriba la dirección.
    // Importante: limpiamos `Pedido.Domicilio.direccion` para que NO cierre la conversación.
    // ==============================
    try {
      if (pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const dom = (typeof pedido.Domicilio === "string")
          ? { direccion: pedido.Domicilio }
          : (pedido.Domicilio || {});
        pedido.Domicilio = dom;

        const addrParts = [
          dom.direccion,
          [dom.calle, dom.numero].filter(Boolean).join(" "),
          dom.barrio,
          dom.ciudad || dom.localidad,
          dom.provincia,
          dom.cp
        ].filter(Boolean);
        const address = addrParts.join(", ").trim();
        if (address) {
          const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
          const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
          const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
          const addressFinal = /,/.test(address)
            ? address
            : [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");

          const geo = await geocodeAddress(addressFinal);
          const exact = Boolean(geo && geo.exact);

          if (!exact) {
            // Evitar cierre por pedido "completo" y evitar envío/distance incorrectos
            estado = "IN_PROGRESS";
            pedido.distancia_km = null;
            if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
              delete pedido.Domicilio.lat;
              delete pedido.Domicilio.lon;
              pedido.Domicilio.direccion = "";
            }
            // Quitar item de envío si ya fue agregado por ensureEnvioSmart
            if (Array.isArray(pedido.items)) {
              pedido.items = pedido.items.filter(i => !/env[ií]o/i.test(String(i?.descripcion || "")));
            }
            // Recalcular total
            try {
              const { pedidoCorr } = recalcAndDetectMismatch(pedido);
              pedido = pedidoCorr;
            } catch {}

            responseText = "📍 No pude ubicar *exactamente* esa dirección en Google Maps.\n\nPor favor escribila nuevamente con *calle y número*, y si podés agregá *barrio/localidad*.\nEj: *Moreno 247, Venado Tuerto*";
          }
        }
      }
    } catch (e) {
      console.warn("[geo] Validación de dirección exacta falló:", e?.message || e);
    }





    const responseTextSafe = String(responseText || "").trim()
      || (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length
          ? buildBackendSummary(pedido, { showEnvio: wantsDetail })
          : "Perfecto, sigo acá. ¿Querés confirmar o cambiar algo?");
    await sendWhatsAppMessage(from, responseTextSafe);
    
    
    
    // 2) Guardar ahora el mismo texto y el snapshot JSON (mismo estado/pedido finales)




    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: String(responseTextSafe || ""),
          type: "text",
          meta: { model: "gpt" }
        });
      } catch (e) {
        console.error("saveMessage(assistant text final):", e?.message);
      }
      try {
        const snap = {
          response: typeof responseTextSafe === "string" ? responseTextSafe : "",
          estado: typeof estado === "string" ? estado : "IN_PROGRESS",
          Pedido: (pedido && typeof pedido === "object")
            ? pedido
            : { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 }
        };
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: JSON.stringify(snap),
          type: "json",
          meta: { model: "gpt", kind: "pedido-snapshot" }
        });
      } catch (e) {
        console.error("saveMessage(assistant json final):", e?.message);
      }
    }




    try {
     // 🔹 Distancia + geocoding + Envío dinámico
      let distKm = null;
      if (pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const store = getStoreCoords();
        if (store) {
          let { lat, lon } = pedido.Domicilio;

          // Geocodificamos si faltan coords
          if (!(typeof lat === "number" && typeof lon === "number")) {
            const addrParts = [
              pedido.Domicilio.direccion,
              [pedido.Domicilio.calle, pedido.Domicilio.numero].filter(Boolean).join(" "),
              pedido.Domicilio.barrio,
              pedido.Domicilio.ciudad || pedido.Domicilio.localidad,
              pedido.Domicilio.provincia,
              pedido.Domicilio.cp
            ].filter(Boolean);
            const address = addrParts.join(", ").trim();
            if (address) {
              // ➕ Si el usuario solo escribió "Moreno 2862", agregamos localidad por defecto
              const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
              const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
              const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
              const addressFinal = /,/.test(address) ? address : [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
              console.log(`[geo] Direccion compilada='${addressFinal}'`);
             
              const geo = await geocodeAddress(addressFinal);
              if (geo && geo.exact) {
                lat = geo.lat; lon = geo.lon;
                pedido.Domicilio.lat = lat;
                pedido.Domicilio.lon = lon;
                console.log(`[geo] OK lat=${lat}, lon=${lon}`);
              } else {
                
                const reason = geo ? `inexacto (partial=${geo.partial_match}, type=${geo.location_type})` : "sin resultado";
                console.warn(`[geo] Geocoding ${reason}. No uso coords para distancia/envío.`);
 
              }
            }
          }

          // Si ya tenemos coords → calcular distancia
          if (typeof lat === "number" && typeof lon === "number") {
            distKm = calcularDistanciaKm(store.lat, store.lon, lat, lon);
            pedido.distancia_km = distKm;
            console.log(`📍 Distancia calculada al domicilio: ${distKm} km`);

            // Buscar producto de Envío según km
            const db = await getDb();
            const envioProd = await pickEnvioProductByDistance(db, tenant || null, distKm);
            if (envioProd && typeof envioProd.importe === "number") {
                 console.log(`[envio] Seleccionado por distancia: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              const idx = (pedido.items || []).findIndex(i =>
                String(i.descripcion || "").toLowerCase().includes("envio")
              );
              if (idx >= 0) {
                 const cantidad = Number(pedido.items[idx].cantidad || 1);
                const prevImporte = Number(pedido.items[idx].importe_unitario || 0);
                const prevDesc = String(pedido.items[idx].descripcion || "");

                // ✅ Actualizar TODO: id, descripción, unitario y total
                pedido.items[idx].id = envioProd._id || pedido.items[idx].id || 0;
                pedido.items[idx].descripcion = envioProd.descripcion;
                pedido.items[idx].importe_unitario = Number(envioProd.importe);
                pedido.items[idx].total = cantidad * Number(envioProd.importe);

                const changed = (prevImporte !== Number(envioProd.importe)) || (prevDesc !== envioProd.descripcion);
                if (changed) console.log(`[envio] Ajustado item existente: '${prevDesc}' @ ${prevImporte} -> '${envioProd.descripcion}' @ ${envioProd.importe}`);
                } else {
                // 🆕 No existía el item Envío: lo insertamos ahora
                (pedido.items ||= []).push({
                  id: envioProd._id || 0,
                  descripcion: envioProd.descripcion,
                  cantidad: 1,
                  importe_unitario: Number(envioProd.importe),
                  total: Number(envioProd.importe),
                });
                console.log(`[envio] Insertado item envío: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              }
              // Recalcular total localmente
              let totalCalc = 0;
              (pedido.items || []).forEach(it => {
                const cant = Number(String(it.cantidad).replace(/[^\d.-]/g,'')) || 0;
                const unit = Number(String(it.importe_unitario).replace(/[^\d.-]/g,'')) || 0;
                it.total = cant * unit;
                totalCalc += it.total;
              });
              pedido.total_pedido = totalCalc;

              // 🔔 (opcional pero útil): si hubo cambio de envío, avisar al cliente con total correcto
            /*  try {
                const totalStr = (Number(pedido.total_pedido)||0).toLocaleString("es-AR");
                await sendWhatsAppMessage(
                  from,
                  `Actualicé el envío según tu dirección (${distKm} km): ${envioProd.descripcion}. Total: $${totalStr}.`
                );
              } catch (e) {
                console.warn("[envio] No se pudo notificar ajuste de envío:", e?.message);
              }*/

            }
          }
        }
      }
   // 🔹 Mantener snapshot del asistente
setAssistantPedidoSnapshot(tenant, from, pedido, estado);

   // 🔹 Mantener snapshot del asistente
	setAssistantPedidoSnapshot(tenant, from, pedido, estado);

	// 🔎 Heurística: si el usuario pidió cancelar, forzamos CANCELLED para el cierre
	// (esto evita que el /admin muestre COMPLETED cuando el modelo respondió mal el estado)
	const _tNorm = String(text || "")
	  .toLowerCase()
	  .normalize("NFD")
	  .replace(/[\u0300-\u036f]/g, "");
	const userWantsCancelRaw =
	  /\b(cancel|anul)(ar|o|a|e|en|ado|ada)?\b/.test(_tNorm) ||
	  /\bdar de baja\b/.test(_tNorm);
	const userCancelNeg =
	  /\bno\s+(quiero\s+)?cancel/.test(_tNorm) ||
	  /\bno\s+(quiero\s+)?anul/.test(_tNorm);
	const userCancelled = !!(userWantsCancelRaw && !userCancelNeg);

	// ¿Cerramos como COMPLETED aunque el modelo no lo haya puesto?
	const userConfirmsFast =
	  /\bconfirm(ar|o|a)\b/i.test(String(text || "")) ||
	  /^s(i|í)\b.*confirm/i.test(String(text || ""));
	const willComplete = !!(estado === "COMPLETED" || (userConfirmsFast && isPedidoCompleto(pedido)));

// 🔹 Persistir pedido definitivo en MongoDB (upsert por conversationId) cuando está COMPLETED
if (willComplete && pedido && convId) {
  try {
    const db = await getDb();
    const nowOrder = new Date();
    const convObjectId = new ObjectId(String(convId));
    const filter = { conversationId: convObjectId, ...(tenant ? { tenantId: tenant } : {}) };

    await db.collection("orders").updateOne(
      filter,
      {
        $set: {
          tenantId: (tenant || null),
          from,
          conversationId: convObjectId,
          pedido,
          estado: "COMPLETED",
          status: "COMPLETED",
          distancia_km: typeof pedido?.distancia_km === "number" ? pedido.distancia_km : (distKm ?? null),
          updatedAt: nowOrder,
        },
        $setOnInsert: { createdAt: nowOrder }
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[orders] error upsert COMPLETED:", e?.message || e);
  }
}
    } catch {}
    try {
	      // Cerramos si:
	      // 1) el usuario canceló explícitamente, o
	      // 2) el flujo terminó (COMPLETED) o
	      // 3) el usuario confirmó explícitamente y el pedido está completo.
	      const closeStatus =
	        (userCancelled || estado === "CANCELLED")
	          ? "CANCELLED"
	          : (willComplete ? "COMPLETED" : null);

	      if (closeStatus) {
	        await closeConversation(convId, closeStatus);
          
	        // 🔄 Mantener estado del pedido en orders (si existe) / crear si no existe
	        try {
	          const db = await getDb();
	          const nowOrder = new Date();
	          const convObjectId = new ObjectId(String(convId));
	          await db.collection("orders").updateOne(
	            { conversationId: convObjectId, ...(tenant ? { tenantId: tenant } : {}) },
	            {
	              $set: {
	                tenantId: (tenant || null),
	                from,
	                conversationId: convObjectId,
	                ...(pedido ? { pedido } : {}),
	                estado: closeStatus,
	                status: closeStatus,
	                updatedAt: nowOrder,
	              },
	              $setOnInsert: { createdAt: nowOrder }
	            },
	            { upsert: true }
	          );
	        } catch (e) {
	          console.error("[orders] error upsert closeStatus:", e?.message || e);
	        }

	        // 🧹 limpiar sesión en memoria para que el próximo msg empiece conversación nueva
	        markSessionEnded(tenant, from);
	      }
    } catch {}

    res.sendStatus(200);
  } catch (e) {
    console.error("POST /webhook error:", e?.message || e);
    res.sendStatus(500);
  }
});


};
