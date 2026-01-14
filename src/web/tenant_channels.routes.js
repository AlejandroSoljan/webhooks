// src/web/tenant_channels.routes.js
// Rutas para configurar canales (WhatsApp/OpenAI) por tenant/telefono.
// Retrocompatible: el webhook cae a .env si no encuentra runtime en DB.

module.exports = function mountTenantChannelsRoutes(app, deps) {
  const { auth, getDb, resolveTenantId, upsertTenantChannel } = deps;

  // ===================== Tenant Channels (WhatsApp/OpenAI por tenant/canal) =====================
  // Permite definir por tenant (y por teléfono) los valores que antes estaban en .env:
  // - phoneNumberId, whatsappToken, verifyToken, openaiApiKey
  // Nota: el webhook usa esta colección para enrutar multi-teléfono.
  //
  // Requiere rol admin.
  app.get("/api/tenant-channels", auth.requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const tenant = String(req.query.tenantId || resolveTenantId(req) || "").trim();

      const q = {};
      if (tenant) q.tenantId = tenant;

      const rows = await db.collection("tenant_channels").find(q).sort({ updatedAt: -1, createdAt: -1 }).toArray();

      // Por seguridad, si NO sos superadmin, enmascaramos secretos al listar
      const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";

      const safe = rows.map(r => ({
        _id: String(r._id),
        tenantId: r.tenantId || null,
        phoneNumberId: r.phoneNumberId || null,
        displayPhoneNumber: r.displayPhoneNumber || null,
        updatedAt: r.updatedAt || null,
        createdAt: r.createdAt || null,
        whatsappToken: isSuper ? (r.whatsappToken || null) : (r.whatsappToken ? "********" : null),
        verifyToken: isSuper ? (r.verifyToken || null) : (r.verifyToken ? "********" : null),
        openaiApiKey: isSuper ? (r.openaiApiKey || null) : (r.openaiApiKey ? "********" : null),
      }));

      res.json({ ok: true, tenant: tenant || null, items: safe });
    } catch (e) {
      console.error("GET /api/tenant-channels error:", e?.message || e);
      res.status(500).json({ error: "internal" });
    }
  });

  app.post("/api/tenant-channels", auth.requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      // Si NO es superadmin, forzamos tenantId al del usuario (no puede escribir otros tenants)
      const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";
      const tenantForced = resolveTenantId(req);

      const payload = {
        tenantId: isSuper ? (body.tenantId || tenantForced) : tenantForced,
        phoneNumberId: body.phoneNumberId,
        displayPhoneNumber: body.displayPhoneNumber,
        whatsappToken: body.whatsappToken,
        verifyToken: body.verifyToken,
        openaiApiKey: body.openaiApiKey,
      };

      const r = await upsertTenantChannel(payload, { allowSecrets: true });
      res.json({ ok: true, result: r });
    } catch (e) {
      console.error("POST /api/tenant-channels error:", e?.message || e);
      res.status(400).json({ error: e?.message || "bad_request" });
    }
  });
};
