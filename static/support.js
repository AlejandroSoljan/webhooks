// Asisto | Version: 5.00.063 | Fecha: 2026-09-08
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
  let historyRange = null;
  async function historyProgress() {
    if (!historyRange) return;
    const state = await api('/history/status?' + new URLSearchParams(historyRange));
    const waiting = state.pending + state.processing;
    const problem = state.errors.map(code => errors[code] || code).join(' · ');
    $('historyResult').textContent = `${state.done} conversaciones del período procesadas · ${waiting} pendientes/en proceso · ${state.failed} con error.${problem ? ' ' + problem : ''}${state.syncPending > 0 ? ' El historial todavía está sincronizando; los mensajes que lleguen dentro del período se agregarán automáticamente.' : !waiting && !state.failed ? ' Si hay resultados, aparecerán en la Bandeja.' : ''}`;
    if (!waiting && state.syncPending === 0) historyRange = null;
  }
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
    const status = await api('/status'); $('deviceStatus').textContent = status.workerRunning ? 'Tu agente está activo en tu PC.' + (status.queuedMessages > 0 ? ` Quedan ${status.queuedMessages} mensajes del historial total por sincronizar; ese número no es el total del período elegido.` : '') : 'Tu agente no está conectado. Instalalo o encendé la PC donde lo autorizaste.';
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
      const who = row.fields.contact || row.jid.replace(/@s\.whatsapp\.net$/, '');
      const when = new Date(row.fields.messageDate).toLocaleString('es-AR');
      button.textContent = `${who} · ${when} · ${row.fields.subject || (row.state === 'ignored' ? 'Descartado por el detector' : 'Conversación para revisar')} · ${caption(row.state)}`;
      button.onclick = action(async () => { await save(); await show(selected?._id === row._id && selected.revision > row.revision ? selected : row); }); item.append(button); $('drafts').append(item);
    }
    if (!rows.length) $('drafts').textContent = $('draftView').value === 'tasks' ? 'No hay borradores para revisar. Podés consultar los descartados por el detector en Mostrar. Revisá el progreso del período para ver si quedan conversaciones pendientes.' : 'No hay conversaciones en esta vista.';
  }
  async function refresh(more = false) {
    if (loading) return; loading = true;
    const view = $('draftView').value;
    try { const query = new URLSearchParams({ view }); if (more && rows.length) query.set('before', rows.at(-1)._id); const page = await api('/drafts?' + query); if (view !== $('draftView').value) return; rows = more ? [...rows, ...page] : page; $('more').hidden = page.length < 50; renderList(); } finally { loading = false; if (view !== $('draftView').value) await refresh(); }
  }
  async function show(row) {
    selected = structuredClone(row); dirty = false; $('fields').replaceChildren(); $('editor').hidden = false;
    selectionLabel();
    const discarded = row.state === 'ignored' || (row.fields.result === 'ignored' && !row.fields.subject);
    $('discarded').hidden = !discarded; $('editor').hidden = discarded;
    $('reviewTitle').textContent = discarded ? 'Conversación descartada por el detector' : 'Revisión del borrador';
    if (discarded) {
      $('discardedEvidence').textContent = row.source.description || 'Cargando los mensajes considerados…';
      if (!row.source.description) {
        const evidence = await api('/drafts/' + row._id + '/evidence');
        if (selected?._id === row._id) $('discardedEvidence').textContent = evidence.description || 'Los mensajes originales ya no están disponibles.';
      }
      return;
    }
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
  $('connect').onclick = action(async () => {
    $('connect').disabled = true;
    try {
      let local;
      try {
        const response = await fetch('http://127.0.0.1:17658/pairing', { headers: { 'X-Asisto-Local': '1' }, credentials: 'omit', cache: 'no-store', targetAddressSpace: 'loopback', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('local_unavailable');
        local = await response.json();
      } catch { throw new Error('No se pudo acceder al agente de esta PC. Comprobá que esté iniciado y permití el acceso local si el navegador lo solicita.'); }
      if (local.state === 'pending' && /^[A-F0-9]{12}$/.test(local.code || '')) {
        await api('/device/approve', 'POST', { code: local.code });
      } else if (local.state === 'approved') {
        const identity = await api('/capabilities');
        if (local.userId !== identity.userId || local.tenantId !== identity.tenantId) throw new Error('El agente de esta PC pertenece a otra cuenta de Asisto. Ingresá con esa cuenta para desvincularlo antes de cambiar de usuario.');
      } else throw new Error('El agente está preparando la conexión. Volvé a intentar en unos segundos.');
      await api('/session', 'POST', { desired: 'connected' });
      $('notice').textContent = 'Conectando tu WhatsApp. El QR aparecerá aquí.';
      await session();
    } finally { $('connect').disabled = false; }
  });
  $('disconnect').onclick = action(async () => { await api('/session', 'POST', { desired: 'disconnected' }); await session(); });
  $('settingsForm').onsubmit = action(async () => { const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean); await api('/settings', 'PUT', { inactivityMs: Number($('inactivity').value) * 60000, mode: $('mode').value, excludedJids: lines('excludedJids'), excludedNames: lines('excludedNames') }); $('notice').textContent = 'Preferencias guardadas.'; });
  $('historyForm').onsubmit = action(async () => {
    $('historySubmit').disabled = true; historyRange = null;
    $('historyResult').textContent = 'Buscando mensajes sincronizados en el período…';
    try {
      const requested = { from: new Date($('from').value).toISOString(), to: new Date($('to').value).toISOString() };
      const result = await api('/history', 'POST', requested);
      historyRange = requested;
      if (!result.conversations) {
        $('historyResult').textContent = 'Solicitud guardada. Todavía no hay mensajes sincronizados en ese período; los que lleguen dentro de esas fechas se procesarán automáticamente. Esta acción no descarga por sí sola el historial del teléfono.';
      } else {
        historyRange = requested;
        $('historyResult').textContent = `${result.messages} mensajes de ${result.conversations} conversaciones encolados. El agente de tu PC debe permanecer activo para procesarlos.`;
      }
    } catch (error) { $('historyResult').textContent = errors[error.message] || error.message; throw error; }
    finally { $('historySubmit').disabled = false; }
  });
  $('tokenForm').onsubmit = action(async () => { try { await api('/hubspot', 'PUT', { token: $('token').value }); $('notice').textContent = 'HubSpot conectado.'; } finally { $('token').value = ''; } });
  $('memoryForm').onsubmit = action(async () => { await api('/memory', 'PUT', { jid: $('memoryJid').value, company: $('memoryCompany').value, contact: $('memoryContact').value }); $('notice').textContent = 'Contacto y empresa guardados en Asisto para próximos borradores.'; await memories(); });
  $('refresh').onclick = action(() => refresh()); $('more').onclick = action(() => refresh(true)); $('editor').onsubmit = action(save);
  $('draftView').onchange = action(async () => { await save(); selected = null; $('editor').hidden = true; $('discarded').hidden = true; $('selection').textContent = 'Seleccioná una conversación.'; renderedList = null; await refresh(); });
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
    if (deviceCode) { $('deviceForm').hidden = false; $('deviceCode').value = deviceCode; await lookupDevice(); }
  }
  $('setupRefresh').onclick = action(initialize);
  initialize().catch(notice);
  setInterval(() => { if (ready && !document.hidden) Promise.all(connectionOnly ? [session()] : [session(), refresh(), historyProgress()]).catch(notice); }, 5000);
})();
