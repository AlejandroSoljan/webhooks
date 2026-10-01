// Asisto | Version: 5.00.275 | Fecha: 2026-10-01
const $ = id => document.getElementById(id);
let owner = '', session, current, metadata, connection, tabId, busy = false, selectionGeneration = 0, refreshGeneration = 0, companyTimer, companyGeneration = 0;
let consumedOpenAt = null;
let pendingContextRefresh = false;
const unsavedEdits = new Map();
const draftStorageKey = id => 'editor-draft-' + id;
function persistEditorDraft(id, draft) {
  if (!id) return;
  Promise.resolve(chrome.storage.session.set?.({ [draftStorageKey(id)]: { ...draft, savedAt: Date.now() } })).catch(() => {});
}
function removePersistedDraft(id) {
  if (!id) return;
  Promise.resolve(chrome.storage.session.remove?.(draftStorageKey(id))).catch(() => {});
}
let controlTimer, controlGeneration = 0;
async function loadContactControl() {
  const generation = ++controlGeneration;
  const rows = await api('CONTACT_CONTROL', { query: $('controlSearch').value });
  if (generation !== controlGeneration) return;
  $('controlResults').replaceChildren();
  if (!rows.length) $('controlResults').textContent = 'No se encontraron contactos sincronizados.';
  for (const row of rows) {
    const label = document.createElement('label'), check = document.createElement('input'), name = document.createElement('span');
    label.className = 'contact-control-row'; check.type = 'checkbox'; check.checked = !row.excluded; check.disabled = row.locked;
    name.textContent = row.name + (row.locked ? ' · Excluido por el dominio' : row.excluded ? ' · Sin control de tareas' : '');
    check.onchange = async () => {
      const excluded = !check.checked;
      check.disabled = true;
      name.textContent = row.name + (excluded ? ' · Guardando…' : ' · Activando…');
      try {
        await api('SET_CONTACT_CONTROL', { jid: row.jid, excluded });
        row.excluded = excluded; name.textContent = row.name + (row.locked ? ' · Excluido por el dominio' : excluded ? ' · Sin control de tareas' : '');
        await chrome.storage.session.set({ contactControlUpdated: Date.now() });
        notice(excluded ? 'No se analizarán tareas de ' + row.name + '.' : 'Control de tareas activado para ' + row.name + '.');
      } catch (error) {
        check.checked = !excluded; name.textContent = row.name + (row.locked ? ' · Excluido por el dominio' : row.excluded ? ' · Sin control de tareas' : '');
        notice(errors[error.message] || 'No se pudo guardar el cambio.', true);
      } finally { check.disabled = row.locked; }
    };
    label.append(check, name); $('controlResults').append(label);
  }
}
const errors = {
  agent_access_denied: 'El agente local rechazó el acceso de la extensión. Actualizá el agente y recargá la extensión.',
  authentication_required: 'No se encontró la autorización del agente de esta PC.', agent_not_authorized: 'Iniciá el agente Baileys autorizado en esta PC.', connection_failed: 'No se pudo conectar con el agente Baileys de esta PC.',
  account_changed: 'Cambió el usuario de Asisto. Pulsá Actualizar para cargar sus tareas.', forbidden: 'Tu usuario necesita acceso a Tickets desde WhatsApp en Asisto.',
  revision_conflict: 'La tarea cambió. Seleccionala nuevamente para cargar la última versión.', source_reconciliation_required: 'Revisá los mensajes nuevos o la agrupación de esta tarea en Asisto antes de enviarla.',
  hubspot_not_configured: 'Falta conectar HubSpot para este dominio.', hubspot_mapping_required: 'Completá la clasificación de HubSpot.',
  invalid_internal_option: 'Elegí una opción válida de HubSpot en cada clasificación.', invalid_pipeline_stage: 'Elegí el pipeline y el estado de HubSpot.',
  approval_fields_required: 'Completá el nombre de la tarea y la empresa antes de guardar en HubSpot.', hubspot_company_required: 'Elegí una empresa de las sugerencias de HubSpot.',
  hubspot_delivery_unconfirmed: 'HubSpot no confirmó el resultado. No se volverá a crear el ticket automáticamente. Revisá en HubSpot antes de reintentar.',
  hubspot_request_failed: 'HubSpot rechazó la operación. Revisá los permisos de la conexión y los campos seleccionados.',
  hubspot_associations_changed: 'La empresa o el contacto asociado cambió. Ajustá la asociación del ticket existente desde HubSpot.',
  hubspot_portal_changed: 'La conexión ahora pertenece a otro portal de HubSpot. Revisá el ticket en su portal original.',
  conversation_excluded: 'Esta conversación está excluida en Asisto.', extension_session_expired: 'La sesión venció. Pulsá Actualizar.',
  hubspot_insufficient_scopes: 'La aplicación de HubSpot necesita permisos de tickets y lectura de empresas y contactos.', hubspot_invalid_credentials: 'HubSpot rechazó la credencial configurada.',
  hubspot_ticket_properties_forbidden: 'HubSpot rechazó la lectura de propiedades de tickets. Revisá el permiso tickets del token cargado en Render.',
  hubspot_ticket_pipelines_forbidden: 'HubSpot rechazó la lectura de pipelines de tickets. Revisá el permiso tickets del token cargado en Render.',
  hubspot_owners_forbidden: 'HubSpot rechazó la lista de responsables. Habilitá la lectura de propietarios/usuarios para la aplicación privada.',
  hubspot_company_associations_forbidden: 'HubSpot rechazó la asociación de tickets con empresas.',
  hubspot_contact_associations_forbidden: 'HubSpot rechazó la asociación de tickets con contactos.',
  hubspot_companies_forbidden: 'HubSpot rechazó la lectura de empresas para el token cargado en Render.',
  hubspot_contacts_forbidden: 'HubSpot rechazó la lectura de contactos para el token cargado en Render.',
  hubspot_tickets_forbidden: 'HubSpot rechazó la creación del ticket para el token cargado en Render.',
  hubspot_ticket_search_incomplete: 'La empresa tiene demasiados tickets abiertos para comprobar duplicados. La tarea quedó guardada; revisá los tickets abiertos antes de reintentar.',
  hubspot_reference_ticket_has_no_owner: 'El ticket de referencia de HubSpot no tiene un propietario asignado.',
  invalid_hubspot_owner: 'Elegí el usuario responsable del ticket en HubSpot.', hubspot_ticket_schema_incomplete: 'HubSpot no devolvió propietarios, pipelines o propiedades obligatorias del ticket.',
};
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function saveState(message = '', state = '') { $('saveState').textContent = message; $('saveState').className = 'save-state' + (state ? ' ' + state : ''); }
async function api(action, values = {}) {
  const response = await chrome.runtime.sendMessage({ action, owner, ...values });
  if (response?.error) throw new Error(response.error);
  return response.data;
}
async function run(fn) {
  if (busy) return; busy = true;
  document.body.setAttribute('aria-busy', 'true'); $('contacts').disabled = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { await fn(); } catch (error) { notice(errors[error.message] || 'No se pudo completar la operación (' + error.message + ').', true); }
  finally { busy = false; document.body.removeAttribute('aria-busy'); $('contacts').disabled = false; document.querySelectorAll('button').forEach(button => button.disabled = false); if (pendingContextRefresh) { pendingContextRefresh = false; queueMicrotask(() => run(refresh)); } }
}
function option(select, value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); }
function preferredStage(options, status, savedStageId) {
  const matches = options.filter(row => norm(row.label) === norm(status));
  if (matches.length === 1) return matches[0].id;
  return options.some(row => row.id === savedStageId) ? savedStageId : '';
}
const definitions = [ ['subject','Nombre breve'], ['contact','Contacto de WhatsApp'], ['company','Empresa'], ['status','Estado en Asisto'], ['category','Categoría'], ['errorType','Error tipo'], ['channel','Vía de contacto'], ['description','Descripción'], ['companyId','ID de empresa en HubSpot (opcional)'], ['contactId','ID de contacto en HubSpot (opcional)'] ];
function editorFields() {
  return Object.fromEntries(definitions.map(([key]) => [key, $('field-' + key)?.value || '']));
}
function rememberEditorDraft() {
  if (!current?.id || $('editor').hidden || !$('field-subject')) return;
  const draft = { fields: editorFields() };
  unsavedEdits.set(current.id, draft); persistEditorDraft(current.id, draft);
  saveState('Cambios sin guardar', 'dirty');
}
function renderFields() {
  $('fields').replaceChildren();
  const staged = unsavedEdits.get(current.id);
  const displayedFields = staged?.fields || current.fields;
  for (const [key, title] of definitions) {
    const label = document.createElement('label'); label.textContent = title;
    const values = session.choices?.[key];
    const input = document.createElement(values ? 'select' : key === 'description' ? 'textarea' : 'input'); input.id = 'field-' + key;
    if (values) { for (const value of values) option(input, value, value); }
    input.value = displayedFields[key] || ''; input.maxLength = key === 'description' ? 100000 : 200;
    if (key === 'company') {
      input.setAttribute('list', 'hubspot-company-options'); input.placeholder = 'Escribí para buscar en HubSpot'; input.autocomplete = 'off';
      const list = document.createElement('datalist'); list.id = 'hubspot-company-options'; label.append(input, list); $('fields').append(label);
      input.onfocus = () => loadCompanySuggestions(input.value);
      input.oninput = () => { $('field-companyId').value = ''; current.fields.companyId = ''; clearTimeout(companyTimer); companyTimer = setTimeout(() => loadCompanySuggestions(input.value), 300); };
      input.onchange = () => selectSuggestedCompany(input.value);
      continue;
    }
    label.append(input); $('fields').append(label);
  }
  $('source').textContent = current.source?.description || '';
  $('taskState').textContent = current.state === 'ignored' ? 'Desestimada' : current.hubspot?.ticketId ? 'Ticket ' + current.hubspot.ticketId : current.hubspot?.state === 'awaiting_configuration' ? 'Pendiente de HubSpot' : 'Borrador';
  if (/^\d+$/.test(String(current.hubspot?.portalId || '')) && /^\d+$/.test(String(current.hubspot?.ticketId || ''))) {
    const link = document.createElement('a'); link.href = `https://app.hubspot.com/contacts/${current.hubspot.portalId}/record/0-5/${current.hubspot.ticketId}/`; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Abrir ticket ' + current.hubspot.ticketId; $('taskState').replaceChildren(link);
  }
  $('save').textContent = current.hubspot?.ticketId ? 'Actualizar ticket en HubSpot' : 'Crear ticket en HubSpot';
  $('save').hidden = current.state === 'ignored';
  $('dismiss').hidden = !!current.hubspot?.ticketId || current.state === 'ignored';
  const hasNewChanges = current.sourceChanged || current.reconciliationRequired || current.hubspot?.pendingFollowup;
  $('discardChanges').hidden = !current.hubspot?.ticketId || !hasNewChanges;
  $('reviewWarning').hidden = !hasNewChanges;
  $('editor').hidden = false; $('hubspot').hidden = true;
  saveState(staged ? 'Cambios sin guardar' : '', staged ? 'dirty' : '');
}
const companySuggestions = new Map();
async function loadCompanySuggestions(query) {
  const generation = ++companyGeneration;
  try {
    connection ||= await api('HUBSPOT'); if (!connection.configured) return;
    const result = await api('HUBSPOT_SEARCH', { type: 'companies', query: String(query || '').trim() }); if (generation !== companyGeneration) return;
    const list = $('hubspot-company-options'); if (!list) return; list.replaceChildren(); companySuggestions.clear();
    for (const row of result.results || []) {
      const name = row.properties?.name || row.properties?.domain || ('Empresa ' + row.id), domain = row.properties?.domain || '';
      companySuggestions.set(norm(name), { id: row.id, name }); if (domain) companySuggestions.set(norm(domain), { id: row.id, name });
      const item = document.createElement('option'); item.value = name; item.label = domain; list.append(item);
    }
    selectSuggestedCompany($('field-company')?.value);
  } catch (error) { notice(errors[error.message] || 'No se pudieron consultar las empresas de HubSpot.', true); }
}
function selectSuggestedCompany(value) {
  const match = companySuggestions.get(norm(value)); if (!match) return;
  $('field-company').value = match.name; $('field-companyId').value = match.id; current.fields.company = match.name; current.fields.companyId = match.id;
  rememberEditorDraft();
}
async function detail(id) {
  const generation = ++selectionGeneration;
  const next = await api('DETAIL', { id }); if (generation !== selectionGeneration) return;
  if (!unsavedEdits.has(id)) {
    const stored = await chrome.storage.session.get(draftStorageKey(id)); if (generation !== selectionGeneration) return;
    if (stored[draftStorageKey(id)]?.fields) unsavedEdits.set(id, { fields: stored[draftStorageKey(id)].fields });
  }
  current = next; renderFields(); notice('');
  if (unsavedEdits.has(id)) notice('Conservamos los cambios que todavía no guardaste.');
  document.querySelectorAll('#tasks button').forEach(button => button.classList.toggle('selected', button.dataset.id === id));
}
async function selectContact(jid, draftId = '') {
  current = null; ++selectionGeneration; $('editor').hidden = true; $('tasks').replaceChildren();
  if (!jid) return;
  const generation = selectionGeneration, tasks = await api('DRAFTS', { jid });
  if (generation !== selectionGeneration) return;
  const pending = tasks.filter(task => task.status === 'pending');
  for (const task of pending) {
    const button = document.createElement('button'); button.textContent = task.subject + ' · ' + ({ pending: 'Pendiente', saved: 'HubSpot', discarded: 'Desestimada' }[task.status] || task.status); button.dataset.id = task.id;
    button.onclick = () => run(() => detail(task.id)); $('tasks').append(button);
  }
  if (draftId && pending.some(task => task.id === draftId)) await detail(draftId);
  else if (pending.length) await detail(pending[0].id);
  else notice('Este contacto no tiene tareas pendientes.');
}
async function refresh() {
  const generation = ++refreshGeneration, contextGeneration = selectionGeneration;
  const previous = $('contacts').value;
  const previousDraft = current?.id || '';
  $('connectionState').textContent = 'Comprobando conexión…';
  let nextSession;
  try { nextSession = await api('SESSION'); }
  catch (error) { $('connectionState').textContent = 'Sin conexión con Asisto'; $('account').textContent = 'Sesión no disponible'; throw error; }
  if (generation !== refreshGeneration || contextGeneration !== selectionGeneration) return;
  const nextOwner = nextSession.tenantId + ':' + nextSession.userId;
  const index = await api('INDEX');
  if (generation !== refreshGeneration || contextGeneration !== selectionGeneration) return;
  if (index.owner !== nextOwner) throw new Error('account_changed');
  const selected = tabId ? (await chrome.storage.session.get('selection-' + tabId))['selection-' + tabId] : null;
  if (generation !== refreshGeneration || contextGeneration !== selectionGeneration) return;
  session = nextSession; owner = nextOwner;
  $('connectionState').textContent = 'Conectado a Asisto';
  $('account').textContent = session.tenantId + ' · ' + session.username;
  $('contacts').replaceChildren();
  option($('contacts'), '', 'Elegí un contacto');
  const seen = new Set();
  for (const chat of index.chats) { if (seen.has(chat.jid)) continue; seen.add(chat.jid); option($('contacts'), chat.jid, (chat.name || chat.jid) + ' · ' + chat.count); }
  const jid = selected ? selected.jid : previous;
  if (jid && !seen.has(jid)) { const known = (index.knownChats || []).find(chat => chat.jid === jid || chat.aliases?.includes(jid)); option($('contacts'), jid, known?.name || selected?.name || jid); seen.add(jid); }
  const explicitlyRequestedDraft = selected?.refreshAt !== consumedOpenAt ? selected?.draftId : '';
  const requestedDraft = explicitlyRequestedDraft || (jid === previous ? previousDraft : '');
  consumedOpenAt = selected?.refreshAt;
  const keepDirtyEditor = jid === previous && current?.id && unsavedEdits.has(current.id) && (!explicitlyRequestedDraft || explicitlyRequestedDraft === current.id);
  if (seen.has(jid)) {
    $('contacts').value = jid;
    if (keepDirtyEditor) notice('Hay cambios sin guardar. La actualización no reemplazó tu edición.');
    else await selectContact(jid, requestedDraft);
  }
  else {
    current = null; $('editor').hidden = true; $('hubspot').hidden = true; $('tasks').replaceChildren(); $('contacts').value = '';
    notice(selected?.name ? 'Conversación actual: ' + selected.name + '. Todavía no se pudo vincular este contacto con sus tareas.' : index.chats.length ? 'Elegí un contacto o pulsá su icono en WhatsApp Web.' : 'Todavía no hay tareas detectadas. Procesá las conversaciones desde Asisto.');
  }
}
async function save({ hubSpotPending = false } = {}) {
  const selectedId = current.id, fields = editorFields(), serialized = JSON.stringify(fields);
  let action = current.sourceChanged || current.reconciliationRequired ? 'RECONCILE' : 'SAVE';
  saveState('Guardando…', 'saving');
  let saved;
  try {
    try { saved = await api(action, { id: selectedId, revision: current.revision, fields }); }
    catch (error) {
      if (error.message !== 'revision_conflict') throw error;
      const latest = await api('DETAIL', { id: selectedId });
      if (current?.id !== selectedId) return;
      current = latest;
      action = latest.sourceChanged || latest.reconciliationRequired ? 'RECONCILE' : 'SAVE';
      saved = await api(action, { id: selectedId, revision: latest.revision, fields });
    }
  }
  catch (error) { unsavedEdits.set(selectedId, { fields: editorFields() }); saveState('No se guardó. Tus cambios siguen acá.', 'dirty'); throw error; }
  if (current?.id !== selectedId) return;
  current.revision = saved.revision; Object.assign(current.fields, saved.fields || fields); current.sourceChanged = false; current.reconciliationRequired = false;
  const changedWhileSaving = JSON.stringify(editorFields()) !== serialized;
  if (changedWhileSaving) { unsavedEdits.set(current.id, { fields: editorFields() }); saveState('Hay cambios nuevos sin guardar', 'dirty'); }
  else { unsavedEdits.delete(current.id); removePersistedDraft(current.id); saveState(hubSpotPending ? 'Cambios protegidos; enviando a HubSpot…' : 'Guardado temporalmente en Asisto', 'saved'); }
  if (saved.fields && !changedWhileSaving) { $('field-subject').value = saved.fields.subject || ''; $('field-description').value = saved.fields.description || ''; }
  $('reviewWarning').hidden = true; notice(action === 'RECONCILE' ? 'Mensajes nuevos incorporados al resumen.' : hubSpotPending ? 'Cambios protegidos mientras se registran en HubSpot.' : 'Cambios guardados temporalmente en Asisto.');
}
function selectField(container, id, title, options, value = '') {
  const label = document.createElement('label'); label.textContent = title;
  const select = document.createElement('select'); select.id = id; option(select, '', 'Seleccionar…');
  options.forEach(row => option(select, row.value, row.label)); select.value = value; label.append(select); container.append(label); return select;
}
const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function prepareHubSpot() {
  connection = await api('HUBSPOT'); $('connect').hidden = connection.configured;
  if (!connection.configured) {
    const queued = await api('QUEUE', { id: current.id, revision: current.revision });
    current.revision = queued.revision; current.hubspot = { state: 'awaiting_configuration' };
    $('taskState').textContent = 'Pendiente de HubSpot';
    await api('MANUAL_HUBSPOT', { id: current.id, revision: current.revision, fields: current.fields });
    saveState('Cambios protegidos; HubSpot está procesando el ticket…', 'saving');
    notice('HubSpot está completando y guardando el ticket en una pestaña del navegador.');
    return;
  }
  metadata = connection.metadata;
  const key = 'mapping:' + session.tenantId + ':' + session.userId + ':' + connection.portalId;
  const legacyKey = 'mapping:' + session.tenantId + ':' + connection.portalId;
  const stored = await chrome.storage.local.get([key, legacyKey]);
  const saved = stored[key] || stored[legacyKey] || {};
  const container = $('mapping'); container.replaceChildren();
  const ownerOptions = (metadata.owners || []).map(row => ({ value: String(row.id), label: ([row.firstName, row.lastName].filter(Boolean).join(' ') || row.email || ('Usuario ' + row.id)) + (row.email ? ' · ' + row.email : '') }));
  selectField(container, 'hubspot-owner', 'Usuario responsable en HubSpot', ownerOptions, connection.preferredOwnerId || saved.ownerId || (ownerOptions.length === 1 ? ownerOptions[0].value : ''));
  const pipelineOptions = metadata.pipelines.map(p => ({ value: p.id, label: p.label }));
  const assistance = pipelineOptions.filter(p => norm(p.label) === norm('Pipeline de asistencia'));
  const pipeline = selectField(container, 'pipeline', 'Pipeline de HubSpot', pipelineOptions, saved.pipelineId || (assistance.length === 1 ? assistance[0].value : pipelineOptions.length === 1 ? pipelineOptions[0].value : ''));
  const stage = selectField(container, 'stage', 'Estado del ticket en HubSpot', []);
  function stages() {
    stage.replaceChildren(); option(stage, '', 'Seleccionar…');
    const options = metadata.pipelines.find(p => p.id === pipeline.value)?.stages || [];
    options.forEach(row => option(stage, row.id, row.label));
    stage.value = preferredStage(options, current.fields.status, saved.stageId);
  }
  pipeline.onchange = stages; stages();
  for (const [field, title] of [['category','Categoría'],['errorType','Error tipo'],['channel','Vía de contacto']]) {
    const writable = metadata.properties.filter(p => !p.modificationMetadata?.readOnlyValue && !['subject','content','hs_pipeline','hs_pipeline_stage','createdate','closed_date'].includes(p.name));
    const matches = writable.filter(p => norm(p.label) === norm(title));
    const property = selectField(container, 'property-' + field, title + ' · propiedad', writable.map(p => ({ value: p.name, label: p.label })), saved.fields?.[field]?.property || (matches.length === 1 ? matches[0].name : ''));
    const holder = document.createElement('div'); container.append(holder);
    function values() {
      holder.replaceChildren(); const selected = writable.find(p => p.name === property.value); if (!selected) return;
      if (selected.type === 'enumeration') {
        const options = selected.options.filter(o => !o.hidden), matching = options.filter(o => norm(o.label) === norm(current.fields[field]) || o.value === current.fields[field]);
        selectField(holder, 'value-' + field, title + ' · valor', options, matching.length === 1 ? matching[0].value : '');
      } else {
        const label = document.createElement('label'); label.textContent = title + ' · valor';
        const input = document.createElement('input'); input.id = 'value-' + field; input.value = current.fields[field] || ''; label.append(input); holder.append(label);
      }
    }
    property.onchange = values; values();
  }
  $('hubspot').hidden = false; $('ticket').replaceChildren(); $('hubspot').scrollIntoView({ behavior: 'smooth', block: 'start' });
  saveState('Cambios protegidos; falta completar la configuración de HubSpot.', 'dirty');
  notice('Completá cualquier selección pendiente y pulsá Crear ticket en HubSpot.');
}
$('refresh').onclick = () => run(refresh);
$('contactControl').ontoggle = () => { if ($('contactControl').open) run(loadContactControl); };
$('controlSearch').oninput = () => { clearTimeout(controlTimer); controlTimer = setTimeout(() => loadContactControl().catch(error => notice('No se pudieron cargar los contactos.', true)), 300); };
$('contacts').onchange = () => run(() => selectContact($('contacts').value));
$('editor').addEventListener('input', event => { if (event.target?.id?.startsWith('field-')) rememberEditorDraft(); });
$('editor').addEventListener('change', event => { if (event.target?.id?.startsWith('field-')) rememberEditorDraft(); });
$('editor').onsubmit = event => { event.preventDefault(); run(saveAndPublish); };
$('dismiss').onclick = () => run(async () => {
  await api('DISMISS', { id: current.id, revision: current.revision });
  notice('Tarea desestimada.');
  await refresh();
});
$('discardChanges').onclick = () => run(async () => {
  const result = await api('DISCARD_CHANGES', { id: current.id, revision: current.revision });
  current.revision = result.revision;
  current.state = 'approved';
  current.sourceChanged = false;
  current.reconciliationRequired = false;
  current.hubspot.pendingFollowup = false;
  delete current.hubspot.followupAction;
  unsavedEdits.delete(current.id);
  renderFields();
  notice('Cambios nuevos descartados. El ticket existente se conserva sin modificaciones.');
  setTimeout(() => run(refresh), 800);
});
function mappingReady() { return ['hubspot-owner','pipeline','stage','property-category','value-category','property-errorType','value-errorType','property-channel','value-channel'].every(id => $(id)?.value); }
async function publishCurrent(alreadySaved = false) {
  const mapping = { ownerId: $('hubspot-owner').value, pipelineId: $('pipeline').value, stageId: $('stage').value, fields: {} };
  for (const field of ['category','errorType','channel']) { const property = $('property-' + field).value, value = $('value-' + field)?.value; if (!property || !value) throw new Error('hubspot_mapping_required'); mapping.fields[field] = { property, value }; }
  if (!mapping.ownerId) throw new Error('invalid_hubspot_owner');
  if (!mapping.pipelineId || !mapping.stageId) throw new Error('invalid_pipeline_stage');
  if (!$('field-companyId').value) throw new Error('hubspot_company_required');
  if (!alreadySaved) await save();
  const result = await api('PUBLISH', { id: current.id, revision: current.revision, mapping }); current.revision = result.revision; current.hubspot = result;
  await chrome.storage.local.set({ ['mapping:' + session.tenantId + ':' + session.userId + ':' + connection.portalId]: mapping });
  notice(result.matched ? 'Ya existía un ticket abierto similar. Conversación vinculada al ticket ' + result.ticketId + '.' : 'Ticket ' + result.ticketId + ' guardado en HubSpot.'); $('taskState').textContent = 'Ticket ' + result.ticketId;
  saveState('Guardado en HubSpot', 'saved');
  $('ticket').replaceChildren(); if (result.portalId) { const link = document.createElement('a'); link.href = 'https://app.hubspot.com/contacts/' + encodeURIComponent(result.portalId) + '/record/0-5/' + encodeURIComponent(result.ticketId); link.textContent = 'Abrir ticket en HubSpot'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('ticket').append(link); }
  setTimeout(() => run(refresh), 800);
}
async function saveAndPublish() {
  await save({ hubSpotPending: true });
  try {
    await prepareHubSpot();
    if (connection?.configured && mappingReady()) await publishCurrent(true);
  } catch (error) {
    saveState('Cambios protegidos en Asisto; pendiente de guardar en HubSpot.', 'dirty');
    throw error;
  }
}
$('publish').onclick = () => run(() => publishCurrent());
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'session' || !Object.keys(changes).some(key => key.startsWith('selection-'))) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id;
  if (!changes['selection-' + tabId]) return;
  ++selectionGeneration;
  $('hubspot').hidden = true;
  notice(changes['selection-' + tabId].newValue?.name ? 'Cargando ' + changes['selection-' + tabId].newValue.name + '…' : 'Identificando conversación…');
  if (busy) pendingContextRefresh = true;
  else run(refresh);
});
(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id; await run(refresh); })();
