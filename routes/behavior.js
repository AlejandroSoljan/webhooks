// routes/behavior.js
const express = require('express');
const { getDb } = require('../services/db');
const { buildSystemPrompt } = require('../services/behaviorService');

const router = express.Router();

async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: 'behavior' });
  return (doc && doc.text) ? String(doc.text) : "Sos un asistente claro, amable y conciso. Respondé en español.";
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'behavior' },
    { $set: { text: String(newText || '').trim(), updatedAt: new Date() } },
    { upsert: true }
  );
}

router.get("/comportamiento", async (_req, res) => {
  try {
    const text = await loadBehaviorTextFromMongo();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Comportamiento del Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; max-width: 960px; }
    textarea { width: 100%; min-height: 360px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; font-size: 14px; }
    .row { display:flex; gap:8px; align-items:center; }
    .hint { color:#666; font-size: 12px; }
    .tag { padding:2px 6px; border:1px solid #ccc; border-radius:4px; font-size:12px; }
  </style>
</head>
<body>
  <h1>Comportamiento del Bot</h1>
  <div class="row">
    <button id="btnReload">Recargar</button>
    <button id="btnSave">Guardar</button>
    <span class="hint">La configuración se guarda en MongoDB (settings._id="behavior").</span>
  </div>
  <p></p>
  <textarea id="txt"></textarea>
  <script>
    async function load() {
      const r = await fetch('/api/behavior');
      const j = await r.json();
      document.getElementById('txt').value = j.text || '';
    }
    async function save() {
      const v = document.getElementById('txt').value || '';
      const r = await fetch('/api/behavior', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: v })
      });
      if (r.ok) alert('Guardado ✅'); else alert('Error al guardar');
    }
    document.getElementById('btnSave').addEventListener('click', save);
    document.getElementById('btnReload').addEventListener('click', load);
    load();
  </script>
</body>
</html>`);
  } catch (e) {
    console.error("⚠️ /comportamiento error:", e);
    res.status(500).send("internal");
  }
});

router.get("/api/behavior", async (_req, res) => {
  try {
    const text = await loadBehaviorTextFromMongo();
    res.json({ source: "mongo", text });
  } catch (e) {
    res.status(500).json({ error: "internal" });
  }
});

router.post("/api/behavior", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    await saveBehaviorTextToMongo(text);
    await buildSystemPrompt({ force: true }); // invalidar/actualizar cache del prompt
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
});

module.exports = router;
