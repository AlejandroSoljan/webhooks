// order_config_panel.js
// Panel aislado para configurar reglas/validaciones de pedidos por dominio.

const {
  DEFAULT_ORDER_CONFIG,
  normalizeOrderConfig,
  loadOrderConfig,
  saveOrderConfig,
} = require("./order_config");

function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function jsonForHtml(value) {
  return JSON.stringify(value || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function resolveTenant(auth, req) {
  return auth.resolveTenantId(req, {
    defaultTenantId: process.env.TENANT_ID || "default",
    envTenantId: process.env.TENANT_ID,
  });
}

function isSuperAdmin(req) {
  return String(req.user?.role || "").toLowerCase() === "superadmin";
}

const FEATURE_GROUPS = [
  {
    title: "Guardas generales de pedido",
    desc: "Controlan si el backend fuerza repreguntas y bloquea cierres incompletos.",
    items: [
      ["backendGuards", "Activar guardas backend", "Aplica las validaciones defensivas posteriores a la respuesta de IA."],
      ["forceSummaryBeforeClose", "Forzar resumen antes de cerrar", "Evita cerrar COMPLETED/PENDIENTE sin confirmación cuando el pedido está listo."],
      ["scheduleValidation", "Validar horarios", "Valida fecha/hora contra los horarios configurados del dominio."],
      ["geocodeAddressValidation", "Validar dirección con geocoding", "Cuando hay domicilio, intenta validar la dirección y deja pendiente si Maps no la encuentra exacta."],
    ],
  },
  {
    title: "Reglas específicas de productos",
    desc: "Permiten apagar reglas hardcodeadas mientras migrás cada comercio a reglas configurables.",
    items: [
      ["productRules", "Activar reglas de productos", "Llave general para reglas por producto/categoría."],
      ["milanesaMentionGuard", "Regla mención milanesa", "Si el usuario menciona milanesa y no quedó en items, repregunta tipo/preparación."],
      ["chickenCondimentGuard", "Regla condimento pollo", "Evita preguntar condimento de pollo si no hay pollo real en el pedido."],
      ["milanesaNoReaskGuard", "No repreguntar tipo de milanesa", "Evita volver a preguntar carne/pollo si ya está resuelto."],
      ["milanesaWeightLegend", "Leyenda de milanesas por peso", "Agrega/mantiene la leyenda de pesado en resúmenes cuando corresponde."],
    ],
  },
  {
    title: "Pagos, transferencia y envío",
    desc: "Activan o desactivan reglas comerciales sensibles.",
    items: [
      ["paymentTransferFlow", "Flujo de transferencia", "Maneja estados PENDIENTE_IMPORTE/PENDIENTE_COMPROBANTE."],
      ["transferReceiptAnalysis", "Analizar comprobantes", "Analiza imágenes de comprobantes con visión y las usa como texto de entrada."],
      ["transferMilanesaFinalAmount", "Milanesas: importe final manual", "Si hay transferencia con milanesas, exige que el operador informe el importe final."],
      ["deliveryDistance", "Cálculo automático de envío", "Permite geocoding/distancia e ítems de envío por distancia cuando está implementado."],
    ],
  },
];

const REQUIRED_FIELDS = [
  ["items", "Productos/items", "No permite cerrar si no hay productos."],
  ["entrega", "Tipo de entrega", "Exige retiro o domicilio."],
  ["addressForDelivery", "Dirección si es domicilio", "Exige dirección cuando Entrega = domicilio."],
  ["paymentForDelivery", "Pago si es domicilio", "Exige forma de pago cuando Entrega = domicilio y ya hay dirección."],
  ["hora", "Hora del pedido", "Exige hora HH:MM."],
  ["nombre", "Nombre del cliente", "Exige nombre/apellido o nombre válido."],
];

const MESSAGE_FIELDS = [
  ["missingItems", "Falta productos/items"],
  ["missingEntrega", "Falta tipo de entrega"],
  ["missingAddress", "Falta dirección"],
  ["missingPayment", "Falta forma de pago"],
  ["missingHora", "Falta hora"],
  ["missingNombre", "Falta nombre"],
  ["fallbackReady", "Pedido completo / fallback"],
];

const FINALIZATION_FIELDS = [
  [
    "postCompletionReuseMinutes",
    "Minutos para mantener la misma conversación después de confirmar",
    "0 mantiene el comportamiento actual. Si cargás 10, 15, 30, etc., los mensajes posteriores al pedido confirmado quedan dentro de la misma conversación durante ese tiempo."
  ],
  [
    "politeFollowupReply",
    "Respuesta para agradecimientos o cierres después de confirmar",
    "Se usa si el cliente responde algo corto como gracias, ok, listo, 👍 después de que el pedido ya quedó confirmado."
  ],
];

function renderOrderConfigPanel({ tenant, config, user }) {
  const cfg = normalizeOrderConfig(config || {}, tenant);
  const defaults = normalizeOrderConfig(DEFAULT_ORDER_CONFIG, tenant);
  const superAdmin = String(user?.role || "").toLowerCase() === "superadmin";

  const featureCards = FEATURE_GROUPS.map((group) => `
    <section class="card">
      <h3>${htmlEscape(group.title)}</h3>
      <p class="muted">${htmlEscape(group.desc)}</p>
      <div class="checks">
        ${group.items.map(([key, label, desc]) => `
          <label class="checkRow">
            <input type="checkbox" data-feature="${htmlEscape(key)}" ${cfg.features[key] !== false ? "checked" : ""}/>
            <span><strong>${htmlEscape(label)}</strong><small>${htmlEscape(desc)}</small></span>
          </label>
        `).join("")}
      </div>
    </section>
  `).join("");

  const requiredRows = REQUIRED_FIELDS.map(([key, label, desc]) => `
    <label class="checkRow">
      <input type="checkbox" data-required="${htmlEscape(key)}" ${cfg.requiredFields[key] !== false ? "checked" : ""}/>
      <span><strong>${htmlEscape(label)}</strong><small>${htmlEscape(desc)}</small></span>
    </label>
  `).join("");

  const messageRows = MESSAGE_FIELDS.map(([key, label]) => `
    <label class="field">
      <span>${htmlEscape(label)}</span>
      <input data-message="${htmlEscape(key)}" value="${htmlEscape(cfg.messages[key] || defaults.messages[key] || "")}" />
    </label>
  `).join("");

  const finalizationRows = FINALIZATION_FIELDS.map(([key, label, desc]) => {
    const value = cfg.finalizationPolicy?.[key] ?? defaults.finalizationPolicy?.[key] ?? "";
    const type = key === "postCompletionReuseMinutes" ? "number" : "text";
    const attrs = key === "postCompletionReuseMinutes" ? 'min="0" max="1440" step="1"' : "";
    return `
      <label class="field">
        <span>${htmlEscape(label)}</span>
        <input type="${type}" ${attrs} data-finalization="${htmlEscape(key)}" value="${htmlEscape(value)}" />
        <small>${htmlEscape(desc)}</small>
      </label>
    `;
  }).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Reglas de Pedidos</title>
  <style>
    :root{--bg:#0f2741;--card:#fff;--text:#0b1726;--muted:#667085;--border:#e6eaef;--primary:#0e6b66;--danger:#b42318;--soft:#f8fafc;}
    *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f3f6f8;color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:20px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    h1{margin:0;font-size:24px}.muted{color:var(--muted);font-size:13px;margin:6px 0 0;line-height:1.45}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tenantBox{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid var(--border);border-radius:14px;padding:8px 10px}.tenantBox input{width:180px;border:1px solid var(--border);border-radius:10px;padding:8px}.btn{border:0;background:var(--primary);color:#fff;border-radius:12px;padding:10px 13px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.btn.secondary{background:#fff;color:var(--text);border:1px solid var(--border)}.btn.danger{background:#fff;color:var(--danger);border:1px solid rgba(180,35,24,.25)}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:0 10px 22px rgba(15,23,42,.05)}.card h3{margin:0 0 4px;font-size:17px}.checks{display:flex;flex-direction:column;gap:10px;margin-top:12px}.checkRow{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:14px;background:var(--soft)}.checkRow input{width:18px;height:18px;margin-top:2px}.checkRow span{display:flex;flex-direction:column;gap:3px}.checkRow small{color:var(--muted);font-size:12px;line-height:1.35}.wide{grid-column:1/-1}.messages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field{display:flex;flex-direction:column;gap:6px}.field span{font-size:13px;color:#475467;font-weight:650}.field input{border:1px solid var(--border);border-radius:12px;padding:10px;font-size:14px}.field small{color:var(--muted);font-size:12px;line-height:1.35}.notice{border:1px solid rgba(14,107,102,.2);background:rgba(14,107,102,.07);border-radius:14px;padding:12px;margin-bottom:14px;color:#134e4a;font-size:13px}.status{font-size:13px;color:var(--muted);min-height:20px}.jsonBox{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;background:#0b1726;color:#d1fae5;border-radius:14px;padding:12px;max-height:260px;overflow:auto;font-size:12px}
    @media(max-width:760px){.wrap{padding:12px}.grid,.messages{grid-template-columns:1fr}.tenantBox{width:100%;align-items:stretch;flex-direction:column}.tenantBox input{width:100%}.toolbar{width:100%}.btn{flex:1}.card{border-radius:14px;padding:12px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Reglas de Pedidos</h1>
        <p class="muted">Configuración por dominio para prender/apagar validaciones backend sin cambiar código. Si un dominio no tiene configuración guardada, se usan defaults compatibles con el comportamiento actual.</p>
      </div>
      <div class="toolbar">
        <a class="btn secondary" href="/app">Volver</a>
        <button id="saveBtn" class="btn" type="button">Guardar</button>
      </div>
    </div>

    <div class="notice">Dominio activo: <strong id="tenantLabel">${htmlEscape(cfg.tenantId)}</strong>. ${superAdmin ? "Como superadmin podés cargar otro tenant." : "Tu usuario guarda únicamente sobre su dominio."}</div>

    <div class="toolbar" style="margin-bottom:14px">
      <div class="tenantBox">
        <label class="field" style="margin:0">
          <span>Tenant / dominio</span>
          <input id="tenantInput" value="${htmlEscape(cfg.tenantId)}" ${superAdmin ? "" : "readonly"}/>
        </label>
        <button id="loadBtn" class="btn secondary" type="button">Cargar</button>
      </div>
      <button id="defaultsBtn" class="btn danger" type="button">Restaurar defaults en pantalla</button>
      <span id="status" class="status"></span>
    </div>

    <div class="grid">
      ${featureCards}
      <section class="card">
        <h3>Campos obligatorios para cerrar</h3>
        <p class="muted">Estos checks definen qué datos exige el backend antes de permitir COMPLETED/PENDIENTE.</p>
        <div class="checks">${requiredRows}</div>
      </section>
      <section class="card">
        <h3>Mensajes de repregunta</h3>
        <p class="muted">Textos que usa el backend cuando falta un dato obligatorio.</p>
        <div class="messages">${messageRows}</div>
      </section>
      <section class="card wide">
        <h3>Post-confirmación</h3>
        <p class="muted">Controla qué pasa cuando el cliente escribe después de que el pedido quedó confirmado. Sirve para evitar que un “gracias” abra automáticamente una conversación nueva.</p>
        <div class="messages">${finalizationRows}</div>
      </section>
      <section class="card wide">
        <h3>Vista JSON</h3>
        <p class="muted">Referencia técnica de lo que se va a guardar.</p>
        <pre id="jsonPreview" class="jsonBox"></pre>
      </section>
    </div>
  </div>
<script>
const DEFAULTS = ${jsonForHtml(defaults)};
let current = ${jsonForHtml(cfg)};
const statusEl = document.getElementById("status");
const tenantInput = document.getElementById("tenantInput");
const tenantLabel = document.getElementById("tenantLabel");
const preview = document.getElementById("jsonPreview");

function setStatus(msg, error){ statusEl.textContent = msg || ""; statusEl.style.color = error ? "#b42318" : "#667085"; }
function collect(){
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.tenantId = String(tenantInput.value || current.tenantId || DEFAULTS.tenantId || "default").trim() || "default";
  document.querySelectorAll("[data-feature]").forEach(el => { cfg.features[el.dataset.feature] = !!el.checked; });
  document.querySelectorAll("[data-required]").forEach(el => { cfg.requiredFields[el.dataset.required] = !!el.checked; });
  document.querySelectorAll("[data-message]").forEach(el => {
    const v = String(el.value || "").trim();
    cfg.messages[el.dataset.message] = v || DEFAULTS.messages[el.dataset.message] || "";
  });
  cfg.finalizationPolicy ||= {};
  document.querySelectorAll("[data-finalization]").forEach(el => {
    const key = el.dataset.finalization;
    if (key === "postCompletionReuseMinutes") {
      const n = Number(el.value);
      cfg.finalizationPolicy[key] = Number.isFinite(n) ? Math.max(0, Math.min(1440, Math.trunc(n))) : 0;
    } else {
      const v = String(el.value || "").trim();
      cfg.finalizationPolicy[key] = v || DEFAULTS.finalizationPolicy?.[key] || "";
    }
  });
  return cfg;
}
function paint(cfg){
  current = cfg || DEFAULTS;
  tenantInput.value = current.tenantId || DEFAULTS.tenantId || "default";
  tenantLabel.textContent = tenantInput.value;
  document.querySelectorAll("[data-feature]").forEach(el => { el.checked = current.features?.[el.dataset.feature] !== false; });
  document.querySelectorAll("[data-required]").forEach(el => { el.checked = current.requiredFields?.[el.dataset.required] !== false; });
  document.querySelectorAll("[data-message]").forEach(el => { el.value = current.messages?.[el.dataset.message] || DEFAULTS.messages?.[el.dataset.message] || ""; });
  document.querySelectorAll("[data-finalization]").forEach(el => { el.value = current.finalizationPolicy?.[el.dataset.finalization] ?? DEFAULTS.finalizationPolicy?.[el.dataset.finalization] ?? ""; });
  updatePreview();
}
function updatePreview(){ preview.textContent = JSON.stringify(collect(), null, 2); }
document.addEventListener("change", updatePreview);
document.addEventListener("input", updatePreview);

document.getElementById("defaultsBtn").addEventListener("click", () => {
  const tenantId = String(tenantInput.value || current.tenantId || DEFAULTS.tenantId || "default").trim() || "default";
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.tenantId = tenantId;
  paint(cfg);
  setStatus("Defaults cargados en pantalla. Tocá Guardar para persistirlos.");
});

document.getElementById("loadBtn").addEventListener("click", async () => {
  try {
    setStatus("Cargando...");
    const tenant = encodeURIComponent(String(tenantInput.value || "").trim());
    const r = await fetch("/api/order-config/current?tenant=" + tenant, { headers: { "Accept": "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "No se pudo cargar");
    paint(j.config);
    setStatus("Configuración cargada.");
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    setStatus("Guardando...");
    const payload = collect();
    const r = await fetch("/api/order-config/current", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "No se pudo guardar");
    paint(j.config);
    setStatus("Guardado correctamente.");
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});
paint(current);
</script>
</body>
</html>`;
}

function mountOrderConfigPanel(app, { auth }) {
  app.get("/admin/order-config", auth.requireAdmin, async (req, res) => {
    try {
      const tenant = resolveTenant(auth, req);
      const config = await loadOrderConfig(tenant);
      return res.status(200).send(renderOrderConfigPanel({ tenant, config, user: req.user }));
    } catch (e) {
      console.error("GET /admin/order-config error:", e?.message || e);
      return res.status(500).send("Error cargando reglas de pedidos");
    }
  });

  app.get("/api/order-config/defaults", auth.requireAdmin, async (req, res) => {
    const tenant = resolveTenant(auth, req);
    return res.json({ ok: true, tenant, config: normalizeOrderConfig(DEFAULT_ORDER_CONFIG, tenant) });
  });

  app.get("/api/order-config/current", auth.requireAdmin, async (req, res) => {
    try {
      const tenant = resolveTenant(auth, req);
      const config = await loadOrderConfig(tenant);
      return res.json({ ok: true, tenant, config });
    } catch (e) {
      console.error("GET /api/order-config/current error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "internal" });
    }
  });

  app.post("/api/order-config/current", auth.requireAdmin, async (req, res) => {
    try {
      const tenant = resolveTenant(auth, req);
      const config = await saveOrderConfig(tenant, req.body || {}, {
        updatedBy: req.user?.username || req.user?.email || "admin",
      });
      return res.json({ ok: true, tenant, config });
    } catch (e) {
      console.error("POST /api/order-config/current error:", e?.message || e);
      return res.status(400).json({ ok: false, error: e?.message || "bad_request" });
    }
  });
}

module.exports = { mountOrderConfigPanel };
