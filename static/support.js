// Asisto | Version: 5.00.055 | Fecha: 2026-09-08
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const connectionOnly = new URLSearchParams(location.search).get('view') === 'connection';
  if (connectionOnly) {
    document.body.classList.add('connectionOnly');
    document.title = 'Mi PC y WhatsApp · Asisto';
  }
  if (new URLSearchParams(location.search).get('embed') === '1') document.querySelector('header').hidden = true;
  let selected = null, saving = Promise.resolve(), saveTimer, rows = [], dirty = false, loading = false, renderedList = null, savingNow = false, ready = false, hubspotEnabled = false;
  const captions = { pending: 'Pendiente', approved: 'Aprobado', ignored: 'Sin tarea detectada', needs_review: 'Requiere revisión', disconnected: 'Desconectado', connected: 'Conectado', queued: 'Esperando al servicio de WhatsApp', qr: 'Escaneá el QR con tu teléfono', reconnecting: 'Reconectando', logged_out: 'Vinculación cerrada desde WhatsApp', access_revoked: 'Acceso revocado', review: 'Revisar', create: 'Crear', update: 'Actualizar', close: 'Cerrar', ignore: 'Ignorar' };
  const caption = value => captions[value] || value;
  const selectionLabel = () => { $('selection').textContent = `${selected.jid} · ${caption(selected.state)} · revisión ${selected.revision}`; };
  const labels = { messageDate: 'Fecha del mensaje (ISO)', company: 'Empresa', companyId: 'ID de empresa en HubSpot', contact: 'Contacto', contactId: 'ID de contacto en HubSpot', subject: 'Nombre breve', status: 'Estado', channel: 'Vía de contacto', category: 'Categoría', errorType: 'Error tipo', description: 'Descripción', proposedAction: 'Acción propuesta' };
  const choices = { status: ['Nuevo', 'En Proceso', 'Esperando respuesta INTERNA', 'Esperando respuesta CLIENTE', 'Cerrado RESUELTO', 'Cerrado NO RESUELTO'], channel: ['Telefono', 'Email', 'WhatsApp', 'Reunion', 'Interno'], category: ['Solicitud de Datos', 'Analisis e Implementacion', 'Desarrollo', 'Reunion Cliente', 'Soporte Hardware', 'Soporte Preinstall', 'Soporte en Lugar', 'Soporte Remoto', 'Soporte Administrativo', 'Soporte Servidor Virtual'], errorType: ['Error usuario', 'Error software', 'Error configuración', 'Consulta / Capacitacion', 'Configuración / Implementación', 'Actualización', 'Relevamiento', 'Preinstall', 'Falta funcionalidad', 'Falta soporte 3ro', 'No es error'], proposedAction: ['review', 'create', 'update', 'close', 'ignore'] };
  const errors = { revision_conflict: 'El borrador cambió. Actualizá y volvé a seleccionarlo para revisar la versión más reciente.', csrf_rejected: 'No se pudo validar el origen de la solicitud.', source_reconciliation_required: 'Revisá la nueva evidencia antes de aprobar.', approval_fields_required: 'Completá nombre, empresa y acción propuesta antes de aprobar.', hubspot_not_configured: 'Un administrador debe conectar HubSpot.', transcription_provider_required: 'Falta configurar el servicio de transcripción.' };
  function notice(error) { $('notice').textContent = errors[error.message] || error.message; }
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/support' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Asisto-Support': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.redirected) throw new Error('La sesión venció. Volvé a ingresar a Asisto.');
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const action = fn => async event => { event?.preventDefault(); try { await fn(); } catch (e) { notice(e); } };
  let verifiedDeviceCode = null;
  async function lookupDevice() {
    verifiedDeviceCode = null; $('deviceApprove').disabled = true;
    const code = $('deviceCode').value.trim().toUpperCase();
    const device = await api('/device/request/' + encodeURIComponent(code));
    verifiedDeviceCode = device.code; $('deviceName').textContent = `PC: ${device.name}. Autorizá sólo si acabás de instalar el agente en esa PC.`; $('deviceApprove').disabled = false;
  }
  $('deviceCode').oninput = () => { verifiedDeviceCode = null; $('deviceApprove').disabled = true; };
  $('deviceLookup').onclick = action(lookupDevice);
  $('deviceForm').onsubmit = action(async () => {
    if (!verifiedDeviceCode) throw new Error('Primero comprobá la PC.');
    await api('/device/approve', 'POST', { code: verifiedDeviceCode });
    $('deviceApprove').disabled = true; $('deviceName').textContent = 'PC autorizada. El agente iniciará tu sesión de WhatsApp automáticamente.';
  });
  $('deviceRevoke').onclick = action(async () => { await api('/device/revoke', 'POST', {}); $('notice').textContent = 'PC desvinculada de tu cuenta.'; });
  async function session() {
    const status = await api('/status'); $('deviceStatus').textContent = status.workerRunning ? 'Tu agente está activo en tu PC.' : 'Tu agente no está conectado. Instalalo o encendé la PC donde lo autorizaste.';
    const row = await api('/session'); $('sessionState').textContent = caption(row.state);
    $('qr').hidden = !row.qr; if (row.qr) $('qr').src = row.qr; else $('qr').removeAttribute('src');
  }
  async function memories() {
    const records = await api('/memory'); $('memoryList').replaceChildren();
    for (const record of records) {
      const item = document.createElement('li');
      item.textContent = `${record.jid}: ${record.contact || 'Contacto sin nombre'} → ${record.company} · ${record.source === 'hubspot' || record.verifiedAt ? 'Verificado en HubSpot' : 'Registrado en Asisto'}`;
      $('memoryList').append(item);
    }
  }
  function renderList() {
    const signature = JSON.stringify(rows.map(r => [r._id, r.revision, r.state, r.fields.subject]));
    if (signature === renderedList) return;
    renderedList = signature;
    $('drafts').replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.textContent = `${row.fields.subject || 'Conversación sin tarea detectada'} · ${caption(row.state)}`;
      button.onclick = action(async () => { await save(); show(selected?._id === row._id && selected.revision > row.revision ? selected : row); }); item.append(button); $('drafts').append(item);
    }
    if (!rows.length) $('drafts').textContent = 'Todavía no hay conversaciones procesadas.';
  }
  async function refresh(more = false) {
    if (loading) return; loading = true;
    try { const page = await api('/drafts' + (more && rows.length ? '?before=' + rows.at(-1)._id : '')); rows = more ? [...rows, ...page] : page; $('more').hidden = page.length < 50; renderList(); } finally { loading = false; }
  }
  function show(row) {
    selected = structuredClone(row); dirty = false; $('fields').replaceChildren(); $('editor').hidden = false;
    selectionLabel();
    $('memoryJid').value = row.jid; $('memoryCompany').value = row.fields.company || ''; $('memoryContact').value = row.fields.contact || ''; $('existingTickets').textContent = '';
    $('evidence').textContent = row.source.description || row.source.reason || '';
    $('acknowledge').hidden = !row.sourceChanged || !!row.reconciliationRequired;
    $('approve').disabled = !!row.sourceChanged || !!row.reconciliationRequired || row.mode === 'suggest';
    for (const [key, label] of Object.entries(labels)) {
      if (!hubspotEnabled && ['companyId', 'contactId'].includes(key)) continue;
      const wrapper = document.createElement('label'); wrapper.textContent = label;
      const input = document.createElement(key === 'description' ? 'textarea' : choices[key] ? 'select' : 'input'); input.name = key;
      if (choices[key]) for (const value of choices[key]) { const option = document.createElement('option'); option.value = value; option.textContent = caption(value); input.append(option); }
      input.value = row.fields[key] || ''; input.oninput = () => { dirty = true; clearTimeout(saveTimer); $('saveState').textContent = 'Cambios pendientes…'; saveTimer = setTimeout(() => save().catch(notice), 800); };
      wrapper.append(input); $('fields').append(wrapper);
    }
    $('saveState').textContent = 'Guardado';
  }
  async function save() {
    clearTimeout(saveTimer);
    saving = saving.catch(() => {}).then(async () => {
      if (!selected || !dirty) return;
      const draftId = selected._id;
      const fields = Object.fromEntries([...$('fields').querySelectorAll('[name]')].map(el => [el.name, el.value]));
      dirty = false; savingNow = true;
      try {
        const result = await api('/drafts/' + draftId, 'PATCH', { revision: selected.revision, fields });
        selected.revision = result.revision; selected.fields = { ...selected.fields, ...fields }; selected.state = result.state || 'pending'; selectionLabel();
        $('saveState').textContent = dirty ? 'Cambios pendientes…' : 'Guardado';
      } catch (e) { dirty = true; $('saveState').textContent = 'No se guardó. Copiá tus cambios antes de recargar.'; throw e; }
      finally { savingNow = false; }
    });
    return saving;
  }
  $('connect').onclick = action(async () => { await api('/session', 'POST', { desired: 'connected' }); await session(); });
  $('disconnect').onclick = action(async () => { await api('/session', 'POST', { desired: 'disconnected' }); await session(); });
  $('settingsForm').onsubmit = action(async () => { const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean); await api('/settings', 'PUT', { inactivityMs: Number($('inactivity').value) * 60000, mode: $('mode').value, excludedJids: lines('excludedJids'), excludedNames: lines('excludedNames') }); $('notice').textContent = 'Preferencias guardadas.'; });
  $('historyForm').onsubmit = action(async () => { const result = await api('/history', 'POST', { from: new Date($('from').value).toISOString(), to: new Date($('to').value).toISOString() }); $('notice').textContent = `${result.conversations} conversaciones encoladas desde el historial sincronizado.`; });
  $('tokenForm').onsubmit = action(async () => { try { await api('/hubspot', 'PUT', { token: $('token').value }); $('notice').textContent = 'HubSpot conectado.'; } finally { $('token').value = ''; } });
  $('memoryForm').onsubmit = action(async () => { await api('/memory', 'PUT', { jid: $('memoryJid').value, company: $('memoryCompany').value, contact: $('memoryContact').value }); $('notice').textContent = 'Contacto y empresa guardados en Asisto para próximos borradores.'; await memories(); });
  $('refresh').onclick = action(() => refresh()); $('more').onclick = action(() => refresh(true)); $('editor').onsubmit = action(save);
  $('approve').onclick = action(async () => { await save(); const result = await api('/drafts/' + selected._id + '/approve', 'POST', { revision: selected.revision }); selected.revision = result.revision; selected.state = 'approved'; selectionLabel(); $('notice').textContent = 'Aprobación guardada en Asisto. No se envió a HubSpot.'; await refresh(); });
  $('acknowledge').onclick = action(async () => { await save(); const result = await api('/drafts/' + selected._id + '/acknowledge-source', 'POST', { revision: selected.revision }); selected.revision = result.revision; selected.sourceChanged = false; $('approve').disabled = selected.mode === 'suggest'; $('acknowledge').hidden = true; });
  $('tickets').onclick = action(async () => { await save(); const tickets = await api('/hubspot/companies/' + encodeURIComponent(selected.fields.companyId) + '/tickets'); $('existingTickets').textContent = tickets.map(t => `${t.id} · ${t.properties.subject}\n${t.properties.content || ''}`).join('\n\n') || 'No se encontraron tickets.'; });
  $('metrics').onclick = action(async () => { const [jobs, usage] = await Promise.all([api('/jobs'), api('/usage')]); $('metricsBody').textContent = jobs.map(j => `${j.jid}: ${j.state}${j.error ? ' · ' + (errors[j.error] || j.error) : ''}`).join('\n') + '\n\n' + usage.map(u => `${u.model}: ${u.processingUnits} unidades · ${u.costUsd === null ? 'costo desconocido' : '$' + u.costUsd} · ${u.result}`).join('\n'); });
  window.addEventListener('beforeunload', event => { if (dirty || savingNow) { event.preventDefault(); event.returnValue = ''; } });
  async function initialize() {
    const status = await api('/status'); ready = status.ready;
    $('setup').hidden = ready; $('workspace').hidden = !ready;
    if (!ready) {
      $('setupMessage').textContent = 'El panel ya está disponible. Falta completar esta configuración en el servidor para vincular WhatsApp. Un administrador debe realizar estos pasos.';
      $('setupChecks').replaceChildren();
      for (const check of status.checks) { const item = document.createElement('li'); item.textContent = `${check.ok ? 'Listo' : 'Pendiente'}: ${check.label}`; $('setupChecks').append(item); }
      return;
    }
    if (!status.workerRunning) $('notice').textContent = 'La sincronización comenzará cuando tu agente esté activo en tu PC.';
    $('deviceSetup').open = !status.workerRunning || !!new URLSearchParams(location.search).get('device');
    if (!connectionOnly) {
    const capabilities = await api('/capabilities'); hubspotEnabled = capabilities.hubspotEnabled === true;
    $('hubspotSection').hidden = !hubspotEnabled; $('tickets').hidden = !hubspotEnabled;
    const config = await api('/settings'); $('inactivity').value = config.inactivityMs / 60000; $('mode').value = config.mode; $('excludedJids').value = config.excludedJids.join('\n'); $('excludedNames').value = config.excludedNames.join('\n');
    await Promise.all([session(), refresh(), memories()]);
    } else await session();
    const deviceCode = new URLSearchParams(location.search).get('device');
    if (deviceCode) { $('deviceCode').value = deviceCode; await lookupDevice(); }
  }
  $('setupRefresh').onclick = action(initialize);
  initialize().catch(notice);
  setInterval(() => { if (ready && !document.hidden) Promise.all(connectionOnly ? [session()] : [session(), refresh()]).catch(notice); }, 5000);
})();
