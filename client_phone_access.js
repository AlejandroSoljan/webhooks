// client_phone_access.js
// Filtro global de clientes por tenant para todos los canales/lógicas.
// Por compatibilidad, si el filtro no existe o está desactivado, todos responden.

const { getDb } = require('./db');

const SETTINGS_COLLECTION = 'settings';
const SETTINGS_PREFIX = 'client_phone_access:';
const CACHE_TTL_MS = Math.max(1000, Number(process.env.CLIENT_PHONE_ACCESS_CACHE_TTL_MS || 5000) || 5000);
const MAX_NUMBERS = Math.max(1, Number(process.env.CLIENT_PHONE_ACCESS_MAX_NUMBERS || 5000) || 5000);
const configCache = new Map();

function normalizeTenantId(value) {
  return String(value || 'default').trim().toUpperCase() || 'DEFAULT';
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Normaliza teléfonos argentinos para que sean equivalentes:
 * 3462375124, 543462375124 y 5493462375124.
 * Para identificadores de otros canales (Telegram/Instagram), conserva los dígitos.
 */
function normalizeClientIdentifier(value) {
  let d = digitsOnly(value);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);

  if (d.startsWith('549') && d.length >= 13) return d;
  if (d.startsWith('54') && !d.startsWith('549') && d.length >= 12) {
    return '549' + d.slice(2);
  }
  if (d.length === 10 && d.startsWith('3')) {
    return '549' + d;
  }
  return d;
}

function normalizeName(value) {
  return String(value || '').trim().slice(0, 120);
}

function normalizeNumbers(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const byNumber = new Map();

  for (const item of arr) {
    const source = item && typeof item === 'object'
      ? (item.number ?? item.numero ?? item.phone ?? item.telefono ?? item.id ?? '')
      : item;
    const number = normalizeClientIdentifier(source);
    if (!number) continue;

    const name = item && typeof item === 'object'
      ? normalizeName(item.name ?? item.nombre ?? item.label ?? item.descripcion ?? '')
      : '';

    byNumber.set(number, { number, name });
    if (byNumber.size >= MAX_NUMBERS) break;
  }

  return Array.from(byNumber.values()).sort((a, b) => a.number.localeCompare(b.number));
}

function settingsId(tenantId) {
  return SETTINGS_PREFIX + normalizeTenantId(tenantId);
}

function boolLike(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'sí', 'on', 'enabled', 'habilitado'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'deshabilitado'].includes(v)) return false;
  return fallback;
}

function normalizeConfig(doc, tenantId) {
  const tenant = normalizeTenantId(tenantId || doc?.tenantId);
  return {
    tenantId: tenant,
    enabled: boolLike(doc?.enabled ?? doc?.filterEnabled ?? doc?.habilitado, false),
    numbers: normalizeNumbers(doc?.numbers ?? doc?.numeros ?? doc?.allowedNumbers ?? []),
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy || null,
  };
}

function invalidateClientPhoneAccessCache(tenantId) {
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    configCache.clear();
    return;
  }
  configCache.delete(normalizeTenantId(tenantId));
}

async function loadClientPhoneAccessConfig(tenantId, { force = false } = {}) {
  const tenant = normalizeTenantId(tenantId);
  const now = Date.now();
  const cached = configCache.get(tenant);
  if (!force && cached && (now - cached.at) < CACHE_TTL_MS) return cached.value;

  try {
    const db = await getDb();
    const doc = await db.collection(SETTINGS_COLLECTION).findOne({ _id: settingsId(tenant) });
    const value = normalizeConfig(doc || {}, tenant);
    configCache.set(tenant, { at: now, value });
    return value;
  } catch (e) {
    // Si ya había una configuración cacheada, la seguimos respetando.
    if (cached?.value) return cached.value;
    // Compatibilidad: sin configuración disponible, todos quedan habilitados.
    return normalizeConfig({}, tenant);
  }
}

async function saveClientPhoneAccessConfig(tenantId, payload = {}, updatedBy = '') {
  const tenant = normalizeTenantId(tenantId);
  const enabled = boolLike(payload.enabled ?? payload.filterEnabled ?? payload.habilitado, false);
  const numbers = normalizeNumbers(payload.numbers ?? payload.numeros ?? payload.allowedNumbers ?? []);
  const now = new Date();
  const db = await getDb();

  await db.collection(SETTINGS_COLLECTION).updateOne(
    { _id: settingsId(tenant) },
    {
      $setOnInsert: {
        _id: settingsId(tenant),
        createdAt: now,
      },
      $set: {
        tenantId: tenant,
        enabled,
        numbers,
        updatedAt: now,
        updatedBy: String(updatedBy || '').trim() || null,
      },
    },
    { upsert: true }
  );

  invalidateClientPhoneAccessCache(tenant);
  return loadClientPhoneAccessConfig(tenant, { force: true });
}

/**
 * Devuelve allowed=false únicamente cuando el filtro está activado y el
 * identificador no figura en el listado. No envía mensajes ni genera respuestas.
 */
async function isClientPhoneAllowed(tenantId, identifier) {
  const config = await loadClientPhoneAccessConfig(tenantId);
  const normalized = normalizeClientIdentifier(identifier);

  if (!config.enabled) {
    return { allowed: true, enabled: false, normalized, reason: 'filter_disabled' };
  }

  if (!normalized) {
    return { allowed: false, enabled: true, normalized: '', reason: 'identifier_missing' };
  }

  const allowedSet = new Set(config.numbers.map((item) => item.number));
  const allowed = allowedSet.has(normalized);
  return {
    allowed,
    enabled: true,
    normalized,
    reason: allowed ? 'listed' : 'not_listed',
  };
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function resolveTenantFromReq(req, auth) {
  const role = String(req.user?.role || '').toLowerCase();
  const queryTenant = String(req.query?.tenantId || req.query?.tenant || req.body?.tenantId || req.body?.tenant || '').trim();
  const userTenant = String(req.user?.tenantId || '').trim();

  if (role === 'superadmin' && queryTenant) return normalizeTenantId(queryTenant);
  if (userTenant) return normalizeTenantId(userTenant);

  if (auth && typeof auth.resolveTenantId === 'function') {
    return normalizeTenantId(auth.resolveTenantId(req, {
      defaultTenantId: process.env.TENANT_ID || 'default',
      envTenantId: process.env.TENANT_ID || '',
    }));
  }
  return normalizeTenantId(queryTenant || process.env.TENANT_ID || 'default');
}

async function listTenantIds(req) {
  const role = String(req.user?.role || '').toLowerCase();
  const own = normalizeTenantId(req.user?.tenantId || process.env.TENANT_ID || 'default');
  if (role !== 'superadmin') return [own];

  try {
    const db = await getDb();
    const rows = await db.collection('tenant_config')
      .find({}, { projection: { _id: 1, tenantId: 1, tenantid: 1 } })
      .sort({ _id: 1 })
      .limit(1000)
      .toArray();
    const set = new Set([own]);
    for (const row of rows || []) {
      const id = normalizeTenantId(row?.tenantId || row?.tenantid || row?._id || '');
      if (id) set.add(id);
    }
    return Array.from(set).filter(Boolean).sort();
  } catch {
    return [own];
  }
}

function panelHtml({ tenantId, tenants, isSuper, embed }) {
  const safeTenant = htmlEscape(tenantId);
  const tenantOptions = (tenants || []).map((tenant) =>
    `<option value="${htmlEscape(tenant)}"${normalizeTenantId(tenant) === normalizeTenantId(tenantId) ? ' selected' : ''}>${htmlEscape(tenant)}</option>`
  ).join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Clientes habilitados</title>
<style>
  :root{--primary:#0e6b66;--danger:#b42318;--border:#e4e7ec;--muted:#667085;--bg:#f5f7fa;--card:#fff;--text:#101828}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:${embed ? '#fff' : 'var(--bg)'};color:var(--text)}
  .wrap{max-width:1050px;margin:0 auto;padding:22px}
  h1{margin:0 0 6px;font-size:25px}.lead{margin:0 0 20px;color:var(--muted);line-height:1.5}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 8px 24px rgba(16,24,40,.06)}
  .top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  .switchRow{display:flex;align-items:center;gap:12px}.switchRow input{width:22px;height:22px}
  .status{padding:7px 11px;border-radius:999px;font-size:13px;font-weight:700;background:#ecfdf3;color:#027a48}.status.on{background:#fff4e5;color:#b54708}
  .grid{display:grid;grid-template-columns:1.1fr 1fr auto;gap:10px;align-items:end}.field label{display:block;font-size:13px;color:#475467;margin-bottom:6px}
  input,select{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 11px;font-size:14px;background:#fff}
  button{border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}.primary{background:var(--primary);color:#fff}.secondary{background:#fff;border:1px solid var(--border);color:#344054}.danger{background:#fff;border:1px solid #fecdca;color:var(--danger)}
  table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--border);font-size:14px}th{color:#475467}.empty{text-align:center;color:var(--muted);padding:24px}
  .footer{display:flex;justify-content:flex-end;gap:10px;align-items:center;flex-wrap:wrap}.msg{margin-right:auto;font-size:14px;color:var(--muted)}.msg.ok{color:#027a48}.msg.err{color:var(--danger)}
  .warning{display:none;margin-top:12px;padding:11px;border-radius:10px;background:#fff4e5;color:#934b00;font-size:13px}.warning.show{display:block}
  @media(max-width:720px){.grid{grid-template-columns:1fr}.wrap{padding:14px}th:nth-child(2),td:nth-child(2){display:none}}
</style>
</head>
<body>
<div class="wrap">
  <h1>Clientes habilitados</h1>
  <p class="lead">El filtro se aplica por dominio a todos los canales y lógicas. Desactivado, responde a todos. Activado, solamente responde a los números o identificadores cargados; los demás se ignoran sin enviar ningún mensaje.</p>

  ${isSuper ? `<div class="card"><div class="field"><label>Dominio</label><select id="tenantSelect">${tenantOptions}</select></div></div>` : ''}

  <div class="card">
    <div class="top">
      <label class="switchRow"><input id="enabled" type="checkbox"/><span><strong>Habilitar filtro por cliente</strong><br/><small style="color:var(--muted)">Solo responder a los registros del listado.</small></span></label>
      <span id="status" class="status">Todos habilitados</span>
    </div>
    <div id="warning" class="warning">El filtro está activado y el listado está vacío: el bot no responderá a ningún cliente.</div>
  </div>

  <div class="card">
    <div class="grid">
      <div class="field"><label>Número de teléfono o ID</label><input id="number" inputmode="numeric" placeholder="Ej.: 5493462375124"/></div>
      <div class="field"><label>Nombre / referencia (opcional)</label><input id="name" maxlength="120" placeholder="Ej.: Cliente de prueba"/></div>
      <button id="add" class="secondary" type="button">Agregar</button>
    </div>
    <table>
      <thead><tr><th>Número / ID normalizado</th><th>Nombre</th><th style="width:110px">Acción</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <div class="card footer">
    <span id="message" class="msg"></span>
    <button id="reload" class="secondary" type="button">Recargar</button>
    <button id="save" class="primary" type="button">Guardar configuración</button>
  </div>
</div>
<script>
(function(){
  const INITIAL_TENANT = ${JSON.stringify(tenantId).replace(/</g, '\\u003c')};
  const tenantSelect = document.getElementById('tenantSelect');
  const enabled = document.getElementById('enabled');
  const number = document.getElementById('number');
  const name = document.getElementById('name');
  const rows = document.getElementById('rows');
  const status = document.getElementById('status');
  const warning = document.getElementById('warning');
  const message = document.getElementById('message');
  let items = [];

  function tenant(){ return tenantSelect ? tenantSelect.value : INITIAL_TENANT; }
  function digits(v){ return String(v || '').replace(/\\D/g, ''); }
  function normalize(v){
    let d = digits(v); if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('549') && d.length >= 13) return d;
    if (d.startsWith('54') && !d.startsWith('549') && d.length >= 12) return '549' + d.slice(2);
    if (d.length === 10 && d.startsWith('3')) return '549' + d;
    return d;
  }
  function esc(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function setMsg(text, kind){ message.textContent = text || ''; message.className = 'msg' + (kind ? (' ' + kind) : ''); }
  function syncState(){
    const on = !!enabled.checked;
    status.textContent = on ? ('Filtro activo · ' + items.length + ' habilitado' + (items.length === 1 ? '' : 's')) : 'Todos habilitados';
    status.classList.toggle('on', on);
    warning.classList.toggle('show', on && items.length === 0);
  }
  function render(){
    rows.innerHTML = '';
    if (!items.length) {
      rows.innerHTML = '<tr><td class="empty" colspan="3">No hay clientes cargados.</td></tr>';
      syncState(); return;
    }
    items.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><strong>' + esc(item.number) + '</strong></td><td>' + esc(item.name || '-') + '</td><td><button type="button" class="danger" data-remove="' + index + '">Quitar</button></td>';
      rows.appendChild(tr);
    });
    rows.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
      items.splice(Number(btn.dataset.remove), 1); render();
    }));
    syncState();
  }
  async function load(){
    setMsg('Cargando…');
    try {
      const r = await fetch('/api/client-phone-access?tenantId=' + encodeURIComponent(tenant()), { cache:'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo cargar');
      enabled.checked = !!j.config.enabled;
      items = Array.isArray(j.config.numbers) ? j.config.numbers : [];
      render(); setMsg('Configuración cargada.', 'ok');
    } catch (e) { setMsg(e.message || String(e), 'err'); }
  }
  async function save(){
    setMsg('Guardando…');
    try {
      const r = await fetch('/api/client-phone-access?tenantId=' + encodeURIComponent(tenant()), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ enabled: enabled.checked, numbers: items })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo guardar');
      enabled.checked = !!j.config.enabled;
      items = Array.isArray(j.config.numbers) ? j.config.numbers : [];
      render(); setMsg('Configuración guardada.', 'ok');
    } catch (e) { setMsg(e.message || String(e), 'err'); }
  }
  document.getElementById('add').addEventListener('click', () => {
    const n = normalize(number.value);
    if (!n) { setMsg('Ingresá un número o ID válido.', 'err'); number.focus(); return; }
    const item = { number:n, name:String(name.value || '').trim() };
    const idx = items.findIndex((x) => x.number === n);
    if (idx >= 0) items[idx] = item; else items.push(item);
    items.sort((a,b) => a.number.localeCompare(b.number));
    number.value=''; name.value=''; render(); setMsg('Registro agregado. Falta guardar.', '');
  });
  number.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('add').click(); });
  enabled.addEventListener('change', syncState);
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('reload').addEventListener('click', load);
  if (tenantSelect) tenantSelect.addEventListener('change', () => {
    const u = new URL(window.location.href); u.searchParams.set('tenant', tenantSelect.value); window.location.href = u.toString();
  });
  load();
})();
</script>
</body>
</html>`;
}

function mountClientPhoneAccess(app, { auth } = {}) {
  if (!app || app.__clientPhoneAccessMounted) return;
  app.__clientPhoneAccessMounted = true;

  const requireAdmin = auth?.requireAdmin || ((req, res, next) => next());

  app.get('/admin/client-phone-access', requireAdmin, async (req, res) => {
    try {
      const tenantId = resolveTenantFromReq(req, auth);
      const tenants = await listTenantIds(req);
      const isSuper = String(req.user?.role || '').toLowerCase() === 'superadmin';
      const embed = String(req.query?.embed || '') === '1';
      return res.status(200).send(panelHtml({ tenantId, tenants, isSuper, embed }));
    } catch (e) {
      return res.status(500).send('Error cargando panel de clientes habilitados.');
    }
  });

  app.get('/api/client-phone-access', requireAdmin, async (req, res) => {
    try {
      const tenantId = resolveTenantFromReq(req, auth);
      const config = await loadClientPhoneAccessConfig(tenantId, { force: true });
      return res.json({ ok: true, config });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/client-phone-access', requireAdmin, async (req, res) => {
    try {
      const tenantId = resolveTenantFromReq(req, auth);
      const updatedBy = req.user?.username || req.user?.email || 'admin';
     const config = await saveClientPhoneAccessConfig(tenantId, req.body || {}, updatedBy);
      return res.json({ ok: true, config });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

module.exports = {
  mountClientPhoneAccess,
  isClientPhoneAllowed,
  loadClientPhoneAccessConfig,
  saveClientPhoneAccessConfig,
  invalidateClientPhoneAccessCache,
  normalizeClientIdentifier,
  normalizeTenantId,
};
