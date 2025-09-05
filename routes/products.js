// routes/products.js
const express = require('express');
const { getDb } = require('../services/db');
const { ObjectId } = require('mongodb');

const router = express.Router();

router.get("/productos", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Productos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f6f6f6; text-align: left; }
    tr:nth-child(even) { background: #fafafa; }
    .btn { padding: 6px 10px; border: 1px solid #333; background: #fff; cursor: pointer; border-radius: 4px; font-size: 12px; }
    .btn + .btn { margin-left: 6px; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap: wrap; }
    input, textarea { padding:6px; font-size:14px; }
    input[type="number"] { width: 120px; }
    .tag { display:inline-block; padding:2px 6px; border-radius: 4px; font-size: 12px; }
    .tag.active { background:#e6fcf5; color:#2b8a3e; }
    .tag.inactive { background:#fff0f6; color:#c2255c; }
  </style>
</head>
<body>
  <h1>Productos</h1>

  <div class="row">
    <input id="desc" placeholder="Descripción" />
    <input id="precio" type="number" step="0.01" placeholder="Precio" />
    <input id="venta" placeholder="Modo de venta (opcional)" />
    <input id="obs" placeholder="Observaciones (opcional)" style="min-width:240px;flex:1" />
    <button class="btn" onclick="addProduct()">Agregar</button>
  </div>

  <table id="tbl">
    <thead>
      <tr>
        <th>Descripción</th>
        <th>Precio</th>
        <th>Venta</th>
        <th>Obs</th>
        <th>Estado</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <script>
    async function load() {
      const r = await fetch('/api/products');
      const j = await r.json();
      const tb = document.querySelector('#tbl tbody');
      tb.innerHTML = '';
      for (const p of j) {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${p.descripcion || ''}</td>
          <td>\${p.importe ?? ''}</td>
          <td>\${p.venta || ''}</td>
          <td>\${p.observacion || ''}</td>
          <td>\${p.active ? '<span class="tag active">Activo</span>' : '<span class="tag inactive">Inactivo</span>'}</td>
          <td>
            <button class="btn" onclick="toggle('\${p._id}')">\${p.active ? 'Desactivar' : 'Activar'}</button>
            <button class="btn" onclick="removeP('\${p._id}')">Eliminar</button>
          </td>
        \`;
        tb.appendChild(tr);
      }
    }
    async function addProduct() {
      const body = {
        descripcion: document.getElementById('desc').value,
        importe: Number(document.getElementById('precio').value || 0) || null,
        venta: document.getElementById('venta').value || '',
        observacion: document.getElementById('obs').value || ''
      };
      const r = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.ok) { await load(); }
      else alert('No se pudo agregar.');
    }
    async function toggle(id) {
      const r = await fetch('/api/products/' + id + '/toggle', { method: 'POST' });
      if (r.ok) load(); else alert('No se pudo cambiar el estado.');
    }
    async function removeP(id) {
      if (!confirm('¿Eliminar producto?')) return;
      const r = await fetch('/api/products/' + id, { method: 'DELETE' });
      if (r.ok) load(); else alert('No se pudo eliminar.');
    }
    load();
  </script>
</body>
</html>`);
});

router.get("/api/products", async (_req, res) => {
  try {
    const db = await getDb();
    const items = await db.collection('products').find({}).sort({ createdAt: -1 }).toArray();
    res.json(items.map(x => ({ ...x, _id: x._id.toString() })));
  } catch (e) {
    console.error("⚠️ GET /api/products error:", e);
    res.status(500).json([]);
  }
});

router.post("/api/products", async (req, res) => {
  try {
    const { descripcion, importe, venta, observacion } = req.body || {};
    if (!descripcion || !String(descripcion).trim()) return res.status(400).json({ error: "missing_descripcion" });
    const doc = {
      descripcion: String(descripcion).trim(),
      importe: (importe != null && !Number.isNaN(Number(importe))) ? Number(importe) : null,
      venta: String(venta || "").trim(),
      observacion: String(observacion || "").trim(),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const db = await getDb();
    const ins = await db.collection('products').insertOne(doc);
    res.json({ ok: true, _id: ins.insertedId.toString() });
  } catch (e) {
    console.error("⚠️ POST /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

router.post("/api/products/:id/toggle", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    const prod = await db.collection('products').findOne({ _id: new ObjectId(id) });
    if (!prod) return res.status(404).json({ error: "not_found" });
    const next = !prod.active;
    await db.collection('products').updateOne({ _id: prod._id }, { $set: { active: next, updatedAt: new Date() } });
    res.json({ ok: true, active: next });
  } catch (e) {
    console.error("⚠️ POST /api/products/:id/toggle error:", e);
    res.status(500).json({ error: "internal" });
  }
});

router.delete("/api/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    await db.collection('products').deleteOne({ _id: new ObjectId(id) });
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ DELETE /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

module.exports = router;
