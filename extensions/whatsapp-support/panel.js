// Asisto | Version: 5.00.074 | Fecha: 2026-09-09
const $ = id => document.getElementById(id);
let owner = '', session, current, metadata, connection, tabId, busy = false, selectionGeneration = 0;
const errors = {
  authentication_required: 'No se encontró la autorización del agente de esta PC.', agent_not_authorized: 'Iniciá el agente Baileys autorizado en esta PC.', connection_failed: 'No se pudo conectar con el agente Baileys de esta PC.',
  account_changed: 'Cambió el usuario de Asisto. Pulsá Actualizar para cargar sus tareas.', forbidden: 'Tu usuario necesita acceso a Tickets desde WhatsApp en Asisto.',
  revision_conflict: 'La tarea cambió. Seleccionala nuevamente para cargar la última versión.', source_reconciliation_required: 'Revisá los mensajes nuevos o la agrupación de esta tarea en Asisto antes de enviarla.',
  hubspot_not_configured: 'Falta conectar HubSpot para este dominio.', hubspot_mapping_required: 'Completá la clasificación de HubSpot.',
  invalid_internal_option: 'Elegí una opción válida de HubSpot en cada clasificación.', invalid_pipeline_stage: 'Elegí el pipeline y el estado de HubSpot.',
  approval_fields_required: 'Completá el nombre de la tarea y la empresa antes de guardar en HubSpot.',
  hubspot_delivery_unconfirmed: 'HubSpot no confirmó el resultado. No se volverá a crear el ticket automáticamente. Revisá en HubSpot antes de reintentar.',
  hubspot_request_failed: 'HubSpot rechazó la operación. Revisá los permisos de la conexión y los campos seleccionados.',
  hubspot_associations_changed: 'La empresa o el contacto asociado cambió. Ajustá la asociación del ticket existente desde HubSpot.',
  hubspot_portal_changed: 'La conexión ahora pertenece a otro portal de HubSpot. Revisá el ticket en su portal original.',
  conversation_excluded: 'Esta conversación está excluida en Asisto.', extension_session_expired: 'La sesión venció. Pulsá Actualizar.',
};
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(action, values = {}) {
  const response = await chrome.runtime.sendMessage({ action, owner, ...values });
  if (response?.error) throw new Error(response.error);
  return response.data;
}
async function run(fn) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { await fn(); } catch (error) { notice(errors[error.message] || 'No se pudo completar la operación (' + error.message + ').', true); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
function option(select, value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); }
const definitions = [ ['subject','Nombre breve'], ['contact','Contacto de WhatsApp'], ['company','Empresa'], ['status','Estado en Asisto'], ['category','Categoría'], ['errorType','Error tipo'], ['channel','Vía de contacto'], ['description','Descripción'], ['companyId','ID de empresa en HubSpot (opcional)'], ['contactId','ID de contacto en HubSpot (opcional)'] ];
function renderFields() {
  $('fields').replaceChildren();
  for (const [key, title] of definitions) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement(key === 'description' ? 'textarea' : 'input'); input.id = 'field-' + key; input.value = current.fields[key] || ''; input.maxLength = key === 'description' ? 100000 : 200;
    label.append(input); $('fields').append(label);
  }
  $('source').textContent = current.source?.description || '';
  $('taskState').textContent = current.hubspot?.ticketId ? 'Ticket ' + current.hubspot.ticketId : 'Borrador';
  $('reviewWarning').hidden = !current.sourceChanged && !current.reconciliationRequired;
  $('editor').hidden = false; $('hubspot').hidden = true;
}
async function detail(id) {
  const generation = ++selectionGeneration;
  const next = await api('DETAIL', { id }); if (generation !== selectionGeneration) return;
  current = next; renderFields(); notice('');
  document.querySelectorAll('#tasks button').forEach(button => button.classList.toggle('selected', button.dataset.id === id));
}
async function selectContact(jid) {
  current = null; ++selectionGeneration; $('editor').hidden = true; $('tasks').replaceChildren();
  if (!jid) return;
  const generation = selectionGeneration, tasks = await api('DRAFTS', { jid });
  if (generation !== selectionGeneration) return;
  for (const task of tasks) {
    const button = document.createElement('button'); button.textContent = task.subject; button.dataset.id = task.id;
    button.onclick = () => run(() => detail(task.id)); $('tasks').append(button);
  }
  if (tasks.length) await detail(tasks[0].id); else notice('Este contacto no tiene tareas para revisar.');
}
async function refresh() {
  const previous = $('contacts').value;
  owner = ''; current = null; $('editor').hidden = true; $('connect').hidden = true; $('tasks').replaceChildren(); $('contacts').replaceChildren(); $('account').textContent = 'Consultando sesión…';
  session = await api('SESSION'); owner = session.tenantId + ':' + session.userId;
  $('account').textContent = session.tenantId + ' · ' + session.username;
  const index = await api('INDEX');
  if (index.owner !== owner) throw new Error('account_changed');
  option($('contacts'), '', 'Elegí un contacto');
  const seen = new Set();
  for (const chat of index.chats) { if (seen.has(chat.jid)) continue; seen.add(chat.jid); option($('contacts'), chat.jid, (chat.name || chat.jid) + ' · ' + chat.count); }
  const selected = tabId ? (await chrome.storage.session.get('selection-' + tabId))['selection-' + tabId] : null;
  const jid = selected?.jid || previous;
  if (seen.has(jid)) { $('contacts').value = jid; await selectContact(jid); }
  else notice(index.chats.length ? 'Elegí un contacto o pulsá su icono en WhatsApp Web.' : 'Todavía no hay tareas detectadas. Procesá las conversaciones desde Asisto.');
}
async function save() {
  const fields = Object.fromEntries(definitions.map(([key]) => [key, $('field-' + key).value]));
  const saved = await api('SAVE', { id: current.id, revision: current.revision, fields });
  current.revision = saved.revision; Object.assign(current.fields, fields); notice('Cambios guardados en Asisto.');
}
function selectField(container, id, title, options, value = '') {
  const label = document.createElement('label'); label.textContent = title;
  const select = document.createElement('select'); select.id = id; option(select, '', 'Seleccionar…');
  options.forEach(row => option(select, row.value, row.label)); select.value = value; label.append(select); container.append(label); return select;
}
const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function prepareHubSpot() {
  connection = await api('HUBSPOT'); $('connect').hidden = connection.configured;
  if (!connection.configured) { $('connectionForm').hidden = !session.canConfigure; notice('Conectá la aplicación privada existente de HubSpot para este dominio.'); return; }
  metadata = connection.metadata;
  const key = 'mapping:' + session.tenantId + ':' + connection.portalId;
  const saved = (await chrome.storage.local.get(key))[key] || {};
  const container = $('mapping'); container.replaceChildren();
  const pipeline = selectField(container, 'pipeline', 'Pipeline de HubSpot', metadata.pipelines.map(p => ({ value: p.id, label: p.label })), saved.pipelineId);
  const stage = selectField(container, 'stage', 'Estado del ticket en HubSpot', []);
  function stages() {
    stage.replaceChildren(); option(stage, '', 'Seleccionar…');
    const options = metadata.pipelines.find(p => p.id === pipeline.value)?.stages || [];
    options.forEach(row => option(stage, row.id, row.label));
    const matches = options.filter(row => norm(row.label) === norm(current.fields.status));
    stage.value = matches.length === 1 ? matches[0].id : '';
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
  $('hubspot').hidden = false; $('ticket').replaceChildren(); notice('Revisá el pipeline, el estado y las categorías antes de guardar.');
}
$('refresh').onclick = () => run(refresh);
$('contacts').onchange = () => run(() => selectContact($('contacts').value));
$('editor').onsubmit = event => { event.preventDefault(); run(save); };
$('dismiss').onclick = () => run(async () => {
  await api('DISMISS', { id: current.id, revision: current.revision });
  notice('Tarea desestimada.');
  await refresh();
});
$('setup').onclick = () => run(async () => { await save(); await prepareHubSpot(); });
$('connectionForm').onsubmit = event => { event.preventDefault(); run(async () => { const token = $('token').value; $('token').value = ''; await api('CONNECT', { token }); await prepareHubSpot(); }); };
$('publish').onclick = () => run(async () => {
  const mapping = { pipelineId: $('pipeline').value, stageId: $('stage').value, fields: {} };
  for (const field of ['category','errorType','channel']) { const property = $('property-' + field).value, value = $('value-' + field)?.value; if (!property || !value) throw new Error('hubspot_mapping_required'); mapping.fields[field] = { property, value }; }
  if (!mapping.pipelineId || !mapping.stageId) throw new Error('invalid_pipeline_stage');
  await save();
  const result = await api('PUBLISH', { id: current.id, revision: current.revision, mapping }); current.revision = result.revision; current.hubspot = result;
  await chrome.storage.local.set({ ['mapping:' + session.tenantId + ':' + connection.portalId]: mapping });
  notice('Ticket ' + result.ticketId + ' guardado en HubSpot.'); $('taskState').textContent = 'Ticket ' + result.ticketId;
  $('ticket').replaceChildren(); if (result.portalId) { const link = document.createElement('a'); link.href = 'https://app.hubspot.com/contacts/' + encodeURIComponent(result.portalId) + '/record/0-5/' + encodeURIComponent(result.ticketId); link.textContent = 'Abrir ticket en HubSpot'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('ticket').append(link); }
  setTimeout(() => run(refresh), 800);
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'session' || !Object.keys(changes).some(key => key.startsWith('selection-'))) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id;
  if (changes['selection-' + tabId] && !busy) run(refresh);
});
(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id; await run(refresh); })();
