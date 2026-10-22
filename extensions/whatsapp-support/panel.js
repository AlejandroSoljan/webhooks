// Asisto | Version: 5.00.277 | Fecha: 2026-10-02
const $ = id => document.getElementById(id);
document.querySelector('.brand img').title = 'Asisto · Extensión ' + (chrome.runtime.getManifest?.().version || '1.0.61');
let owner = '', session, current, metadata, connection, tabId, busy = false, selectionGeneration = 0, refreshGeneration = 0, companyTimer, companyGeneration = 0;
let consumedOpenAt = null;
let mailDraftId = '', mailGeneration = 0, smtpOwner = '', mailPending = false;
const emailDrafts = new Map();
const emailKey = id => 'email-draft:' + owner + ':' + id;
function taskEmailBody(fields, task) {
  const raw = task?.fields?.messageDate, date = raw ? new Date(raw) : null;
  const stamp = date && Number.isFinite(date.getTime()) ? date.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) + ' (Argentina)' : 'No disponible';
  return `Empresa: ${fields.company || 'Sin identificar'}\nContacto: ${fields.contact || 'Sin identificar'}\nFecha y hora del ticket (conversación): ${stamp}\n\n${fields.description || ''}`;
}
function emailSnapshot() { return { to:$('mailTo').value, subject:$('mailSubject').value, body:$('mailBody').value, key:emailDrafts.get(emailKey(mailDraftId))?.key || crypto.randomUUID() }; }
function rememberEmail() {
  if (!mailDraftId || $('mailComposer').hidden) return;
  const key = emailKey(mailDraftId), value = emailSnapshot(); emailDrafts.set(key,value);
  if (emailDrafts.size > 30) emailDrafts.delete(emailDrafts.keys().next().value);
  Promise.resolve(chrome.storage.session.set?.({[key]:value})).catch(()=>{});
}
async function openTaskEmail() {
  if (!current?.id || mailPending) return;
  const id = current.id, generation = ++mailGeneration, storageKey = emailKey(id), fields = editorFields();
  const stored = await chrome.storage.session.get(storageKey);
  if (generation !== mailGeneration || current?.id !== id) return;
  const previous = emailDrafts.get(storageKey) || stored[storageKey]; mailDraftId = id;
  const value = previous || { to:'', subject:fields.subject, body:taskEmailBody(fields, current), key:crypto.randomUUID() }; emailDrafts.set(storageKey,value);
  $('mailTo').value=value.to; $('mailSubject').value=value.subject; $('mailBody').value=value.body;
  $('mailTaskName').textContent='Tarea: '+fields.subject;
  $('mailState').textContent=''; $('mailNewAttempt').hidden=true; $('mailPreview').hidden=true; $('mailForm').hidden=false; $('mailComposer').hidden=false;
  $('mailConfirm').disabled=false; $('mailReview').disabled=false;
  $('mailContacts').replaceChildren(); $('mailHistory').replaceChildren(); rememberEmail();
  $('mailCompanyContacts').replaceChildren(new Option('Elegir contacto o escribir el email abajo', ''));
  $('mailContactsState').textContent='Consultando contactos de Manager…';
  $('mailCompanyContacts').onchange=()=>{ if (!$('mailCompanyContacts').value) return; $('mailTo').value=$('mailCompanyContacts').value; $('mailTo').dispatchEvent(new Event('input',{bubbles:true})); };
  api('MAIL_CONTACTS').then(result=>{
    if (generation !== mailGeneration || mailDraftId !== id) return;
    for (const row of result.contacts || []) $('mailCompanyContacts').append(new Option(row.name ? `${row.name} · ${row.email}` : row.email,row.email));
    $('mailContactsState').textContent=result.incomplete?'Lista parcial. También podés escribir el destinatario.':result.contacts?.length?'Contactos de HubSpot · @managersistemas.com':'No hay contactos de Manager disponibles. Podés escribir el email.';
  }).catch(()=>{ if (generation === mailGeneration && mailDraftId === id) $('mailContactsState').textContent='No se pudo cargar la lista. Podés escribir el destinatario manualmente.'; });
  if (fields.contact) api('HUBSPOT_SEARCH',{type:'contacts',query:fields.contact}).then(result=>{
    if (generation !== mailGeneration || mailDraftId !== id) return;
    for (const row of result.results || []) { const p=row.properties || {}; if (!p.email) continue; const o=document.createElement('option');o.value=p.email;o.label=[p.firstname,p.lastname].filter(Boolean).join(' ');$('mailContacts').append(o); }
  }).catch(()=>{});
  api('MAIL_HISTORY',{id}).then(rows=>{
    if (generation !== mailGeneration || mailDraftId !== id) return;
    for (const row of rows || []) { const p=document.createElement('p');p.textContent=new Date(row.at).toLocaleString()+' · '+mailStatus(row.state);$('mailHistory').append(p); }
  }).catch(()=>{});
}
function mailStatus(state) { return {accepted:'Aceptado por el servidor SMTP (no confirma entrega al destinatario)',rejected:'Rechazado por SMTP',uncertain:'Resultado sin confirmar. Revisá la casilla antes de volver a enviar.',sending:'Envío iniciado; no confirmado todavía. No lo repitas.'}[state] || 'Sin confirmar'; }
async function loadSMTP() {
  const requestedOwner=owner;
  try {
    const config=await api('MAIL_SETTINGS'); if (requestedOwner !== owner) return;
    for (const [id,key] of [['smtpHost','host'],['smtpPort','port'],['smtpUser','user'],['smtpFrom','from'],['smtpName','name']]) $(id).value=config[key] || (key==='port'?'587':'');
    $('smtpPassword').value='';$('smtpPassword').placeholder=config.configured?'Guardada · dejar vacío para conservar':'Sin configurar';smtpOwner=owner;
    $('smtpState').textContent=config.configured?'Configuración guardada para tu usuario.':'Configurá tu casilla de correo.';
  } catch(e) { $('smtpState').textContent=errors[e.message] || 'No se pudo consultar la configuración de correo.'; }
}
let pendingContextRefresh = false;
const unsavedEdits = new Map();
const draftStorageKey = id => 'editor-draft-' + id;
let profileGeneration = 0;
const profileCache = new Map();
function clearCompanyProfile() { ++profileGeneration; $('companyProfile').hidden = true; $('companyProfile').replaceChildren(); }
async function loadCompanyProfile(companyId = '', jid = '') {
  const generation = ++profileGeneration, box = $('companyProfile'), key = owner + ':' + (companyId || jid);
  if (!companyId && !jid) { clearCompanyProfile(); return; }
  box.hidden = false; box.textContent = 'Consultando empresa en HubSpot…';
  try {
    let cached = profileCache.get(key);
    if (!cached || cached.expires < Date.now()) {
      cached = { expires: Date.now() + 120000, promise: api('COMPANY_PROFILE', { companyId, jid }) };
      profileCache.set(key, cached);
      if (profileCache.size > 30) profileCache.delete(profileCache.keys().next().value);
    }
    const result = await cached.promise;
    if (generation !== profileGeneration) return;
    const company = result?.company;
    box.replaceChildren();
    if (!company) { box.hidden = true; return; }
    const caption = document.createElement('div'); caption.className = 'company-caption'; caption.textContent = 'EMPRESA ASOCIADA · HUBSPOT';
    const heading = document.createElement('div'); heading.className = 'company-heading';
    const name = document.createElement('strong'); name.textContent = company.name || 'Empresa ' + company.id;
    const badge = document.createElement('span'); badge.className = 'company-badge ' + ({ subscriber: 'subscriber', non_subscriber: 'non-subscriber' }[company.status] || 'unknown'); badge.textContent = company.customerType || 'Sin dato';
    heading.append(name, badge); box.append(caption, heading);
    if (company.customerCode) { const code = document.createElement('div'); code.textContent = 'Cliente Nº ' + company.customerCode; box.append(code); }
    const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('dl'); summary.textContent = 'Ver datos de la empresa'; details.append(summary);
    for (const [label, value] of [['Dirección', company.address], ['Localidad', company.city], ['Teléfono', company.phone], ['Otro teléfono', company.otherPhone], ['Celular', company.mobilePhone], ['Sitio web', company.domain]]) {
      if (!value) continue;
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; row.append(dt, dd); list.append(row);
    }
    if (!list.children.length) { const empty = document.createElement('p'); empty.textContent = 'No hay otros datos cargados en HubSpot.'; details.append(empty); }
    details.append(list);
    const contactsTitle = document.createElement('strong'), contactsBox = document.createElement('div');
    contactsTitle.textContent = 'Contactos asociados'; contactsBox.className = 'company-contacts'; details.append(contactsTitle, contactsBox);
    let contactsLoading = false, contactsLoaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || contactsLoading || contactsLoaded) return;
      contactsLoading = true; contactsBox.textContent = 'Consultando contactos…';
      try {
        const data = await api('COMPANY_CONTACTS', { companyId: company.id });
        if (generation !== profileGeneration || !box.contains(details)) return;
        contactsBox.replaceChildren(); contactsLoaded = true;
        for (const contact of data.contacts || []) {
          const row = document.createElement('p'), title = document.createElement('strong'), info = document.createElement('span');
          title.textContent = contact.name || 'Contacto sin nombre';
          info.textContent = [contact.jobTitle, contact.email, contact.phone, contact.mobilePhone !== contact.phone ? contact.mobilePhone : ''].filter(Boolean).join(' · ');
          row.append(title, document.createElement('br'), info); contactsBox.append(row);
        }
        if (!data.contacts?.length) contactsBox.textContent = 'No hay contactos asociados a esta empresa en HubSpot.';
        if (data.incomplete) { const note = document.createElement('p'); note.textContent = 'Listado parcial. Consultá los demás contactos en HubSpot.'; contactsBox.append(note); }
      } catch { if (generation === profileGeneration) contactsBox.textContent = 'No se pudieron cargar los contactos. Cerrá y abrí los datos para reintentar.'; }
      finally { contactsLoading = false; }
    });
    if (/^\d+$/.test(String(result.portalId || '')) && /^\d+$/.test(String(company.id))) { const link = document.createElement('a'); link.href = `https://app.hubspot.com/contacts/${result.portalId}/record/0-2/${company.id}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir empresa en HubSpot ↗'; details.append(link); }
    box.append(details);
  } catch {
    profileCache.delete(key);
    if (generation !== profileGeneration) return;
    box.textContent = 'No se pudieron consultar los datos de la empresa. Podés seguir editando la tarea.';
  }
}
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
  mail_invalid_address: 'Ingresá una dirección de correo válida, sin nombres ni múltiples destinatarios.',
  mail_invalid_server: 'Usá un servidor SMTP público y puerto 465 (TLS) o 587 (STARTTLS).',
  mail_password_required: 'Ingresá la contraseña. Si cambiaste servidor o usuario debés cargarla nuevamente.',
  mail_invalid_config: 'Revisá la configuración del correo.', mail_not_configured: 'Primero configurá y guardá tu casilla de correo.',
  mail_dns_failed: 'No se pudo resolver el servidor SMTP.', mail_server_not_public: 'Sólo se permiten servidores SMTP públicos, no direcciones de red interna.',
  mail_connection_failed: 'No se pudo verificar SMTP. Revisá servidor, puerto, credenciales y habilitación SMTP de tu proveedor.',
  mail_rate_limited: 'Esperá unos segundos antes de reintentar. Se permiten hasta 30 envíos por hora por usuario.',
  mail_invalid_message: 'Completá destinatario, asunto y mensaje.', mail_key_conflict: 'El intento corresponde a otro contenido. Cerrá y revisá el correo antes de enviar.',
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
function toggleSettings(open) {
  $('settingsPanel').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  if (!open) { $('smtpPassword').value = ''; $('settingsToggle').focus(); }
}
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
    const label = document.createElement('label'); label.textContent = title; label.dataset.field = key;
    const values = session.choices?.[key];
    const input = document.createElement(values ? 'select' : key === 'description' ? 'textarea' : 'input'); input.id = 'field-' + key;
    if (values) { for (const value of values) option(input, value, value); }
    input.value = displayedFields[key] || ''; input.maxLength = key === 'description' ? 100000 : 200;
    if (key === 'companyId') input.onchange = () => { void loadCompanyProfile(input.value.trim()); };
    if (key === 'company') {
      input.setAttribute('list', 'hubspot-company-options'); input.placeholder = 'Escribí para buscar en HubSpot'; input.autocomplete = 'off';
      const list = document.createElement('datalist'); list.id = 'hubspot-company-options'; label.append(input, list); $('fields').append(label);
      input.onfocus = () => loadCompanySuggestions(input.value);
      input.oninput = () => { $('field-companyId').value = ''; current.fields.companyId = ''; clearCompanyProfile(); clearTimeout(companyTimer); companyTimer = setTimeout(() => loadCompanySuggestions(input.value), 300); };
      input.onchange = () => selectSuggestedCompany(input.value);
      continue;
    }
    label.append(input); $('fields').append(label);
  }
  $('source').textContent = current.source?.description || '';
  const advanced = document.createElement('details'), advancedTitle = document.createElement('summary');
  advancedTitle.textContent = 'Identificadores de HubSpot'; advanced.append(advancedTitle); advanced.className = 'field-advanced';
  for (const key of ['companyId', 'contactId']) { const label = $('field-' + key)?.closest('label'); if (label) advanced.append(label); }
  $('fields').append(advanced);
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
  if (mailDraftId && mailDraftId !== current.id) $('mailComposer').hidden = true;
  saveState(staged ? 'Cambios sin guardar' : '', staged ? 'dirty' : '');
  void loadCompanyProfile(displayedFields.companyId || '', displayedFields.company ? '' : current.jid || $('contacts').value);
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
  void loadCompanyProfile(match.id);
}
async function detail(id) {
  clearCompanyProfile(); ++companyGeneration; clearTimeout(companyTimer); companySuggestions.clear();
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
  ++mailGeneration; $('mailComposer').hidden=true;
  clearCompanyProfile();
  ++companyGeneration; clearTimeout(companyTimer); companySuggestions.clear();
  current = null; ++selectionGeneration; $('editor').hidden = true; $('tasks').replaceChildren();
  if (!jid) return;
  const generation = selectionGeneration, tasks = await api('DRAFTS', { jid });
  if (generation !== selectionGeneration) return;
  const pending = tasks.filter(task => task.status === 'pending');
  for (const task of pending) {
    const button = document.createElement('button'); button.textContent = task.subject + (task.taskStatus ? ' · ' + task.taskStatus : '') + ' · ' + ({ pending: 'Sin guardar en HubSpot', saved: 'HubSpot', discarded: 'Desestimada' }[task.status] || task.status); button.dataset.id = task.id;
    button.onclick = () => run(() => detail(task.id)); $('tasks').append(button);
  }
  if (draftId && pending.some(task => task.id === draftId)) await detail(draftId);
  else if (pending.length) await detail(pending[0].id);
  else { notice('Este contacto no tiene tareas pendientes.'); void loadCompanyProfile('', jid); }
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
  if (owner && nextOwner !== owner) { clearCompanyProfile(); profileCache.clear(); }
  if (owner && nextOwner !== owner) { ++mailGeneration;mailDraftId='';smtpOwner='';$('mailComposer').hidden=true;$('smtpForm').reset();$('smtpPassword').value='';$('mailSettings').open=false; }
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
  $('headerContact').textContent = selected?.name || index.chats.find(chat => chat.jid === jid)?.name || 'Abrí un chat';
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
    clearCompanyProfile();
    current = null; $('editor').hidden = true; $('hubspot').hidden = true; $('tasks').replaceChildren(); $('contacts').value = '';
    notice(selected?.name ? 'Conversación actual: ' + selected.name + '. Todavía no se pudo vincular este contacto con sus tareas.' : index.chats.length ? 'Abrí un chat en WhatsApp para ver sus tareas.' : 'Todavía no hay tareas detectadas. Procesá las conversaciones desde Asisto.');
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
  return !changedWhileSaving;
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
  unsavedEdits.delete(current.id); removePersistedDraft(current.id);
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
  if (!alreadySaved && !await save()) return;
  if (unsavedEdits.has(current.id)) { saveState('Hay cambios nuevos sin guardar. Pulsá Guardar en HubSpot para enviarlos.', 'dirty'); return; }
  const result = await api('PUBLISH', { id: current.id, revision: current.revision, mapping }); current.revision = result.revision; current.hubspot = result;
  await chrome.storage.local.set({ ['mapping:' + session.tenantId + ':' + session.userId + ':' + connection.portalId]: mapping });
  notice(result.matched ? 'Ya existía un ticket abierto similar. Conversación vinculada al ticket ' + result.ticketId + '.' : 'Ticket ' + result.ticketId + ' guardado en HubSpot.'); $('taskState').textContent = 'Ticket ' + result.ticketId;
  saveState('Guardado en HubSpot', 'saved');
  $('ticket').replaceChildren(); if (result.portalId) { const link = document.createElement('a'); link.href = 'https://app.hubspot.com/contacts/' + encodeURIComponent(result.portalId) + '/record/0-5/' + encodeURIComponent(result.ticketId); link.textContent = 'Abrir ticket en HubSpot'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('ticket').append(link); }
  setTimeout(() => run(refresh), 800);
}
async function saveAndPublish() {
  if (!await save({ hubSpotPending: true })) return;
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
  if (changes['selection-' + tabId].newValue?.jid !== $('contacts').value) clearCompanyProfile();
  ++selectionGeneration;
  $('hubspot').hidden = true;
  notice(changes['selection-' + tabId].newValue?.name ? 'Cargando ' + changes['selection-' + tabId].newValue.name + '…' : 'Identificando conversación…');
  if (busy) pendingContextRefresh = true;
  else run(refresh);
});
$('settingsToggle').onclick=()=>toggleSettings($('settingsPanel').hidden);
$('settingsClose').onclick=()=>toggleSettings(false);
$('settingsPanel').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();toggleSettings(false);}});
$('mailSettings').addEventListener('toggle', () => { if ($('mailSettings').open && smtpOwner !== owner) void loadSMTP(); if (!$('mailSettings').open) $('smtpPassword').value=''; });
$('smtpForm').onsubmit = async event => {
  event.preventDefault(); if (mailPending) return; mailPending=true; $('smtpSave').disabled=true; $('smtpVerify').disabled=true;
  $('smtpForm').querySelectorAll('input,select').forEach(input=>input.disabled=true);
  const config=Object.fromEntries([['host','smtpHost'],['port','smtpPort'],['user','smtpUser'],['password','smtpPassword'],['from','smtpFrom'],['name','smtpName']].map(([key,id])=>[key,$(id).value]));
  try { await api('MAIL_SAVE',{config}); $('smtpPassword').placeholder='Guardada · dejar vacío para conservar'; $('smtpState').textContent='Configuración guardada para tu usuario. Probá la conexión.'; }
  catch(e) { $('smtpState').textContent=errors[e.message] || 'No se pudo guardar la configuración.'; }
  finally { config.password='';$('smtpPassword').value='';mailPending=false;$('smtpSave').disabled=false;$('smtpVerify').disabled=false;$('smtpForm').querySelectorAll('input,select').forEach(input=>input.disabled=false); }
};
$('smtpVerify').onclick=async()=>{
  if(mailPending)return;mailPending=true;$('smtpVerify').disabled=true;$('smtpState').textContent='Probando conexión segura…';
  try { await api('MAIL_VERIFY');$('smtpState').textContent='Conexión y autenticación SMTP verificadas. No se envió ningún correo.'; }
  catch(e){$('smtpState').textContent=errors[e.message] || 'No se pudo comprobar SMTP.';}
  finally{mailPending=false;$('smtpVerify').disabled=false;}
};
$('emailTask').onclick=()=>{void openTaskEmail().catch(()=>{$('mailState').textContent='No se pudo abrir el correo.';});};
$('mailForm').oninput=()=>{
  if(mailPending)return;
  const key=emailKey(mailDraftId), previous=emailDrafts.get(key);
  if(previous) previous.key=crypto.randomUUID();
  $('mailPreview').hidden=true;rememberEmail();
};
$('mailForm').onsubmit=event=>{
  event.preventDefault();if(mailPending)return;rememberEmail();
  $('mailPreviewTo').textContent='Para: '+$('mailTo').value;
  $('mailPreviewSubject').textContent='Asunto: '+$('mailSubject').value;
  $('mailPreviewBody').textContent=$('mailBody').value;
  $('mailForm').hidden=true;$('mailPreview').hidden=false;$('mailConfirm').disabled=false;
};
$('mailEdit').onclick=()=>{if(mailPending)return;$('mailPreview').hidden=true;$('mailForm').hidden=false;};
$('mailClose').onclick=()=>{if(mailPending)return;rememberEmail();++mailGeneration;$('mailComposer').hidden=true;};
$('mailNewAttempt').onclick=()=>{
  if(mailPending || !confirm('Si el intento anterior quedó sin confirmar, revisá primero tu casilla para no duplicar el correo. ¿Querés preparar un nuevo envío?'))return;
  const draft=emailDrafts.get(emailKey(mailDraftId));if(draft)draft.key=crypto.randomUUID();rememberEmail();
  $('mailState').textContent='Nuevo intento. Revisá el destinatario y el contenido antes de confirmar.';$('mailNewAttempt').hidden=true;$('mailPreview').hidden=true;$('mailForm').hidden=false;
};
$('mailConfirm').onclick=async()=>{
  if(mailPending || !mailDraftId || $('mailPreview').hidden)return;
  mailPending=true;$('mailConfirm').disabled=true;$('mailEdit').disabled=true;$('mailClose').disabled=true;
  const id=mailDraftId, generation=mailGeneration, value=emailSnapshot();rememberEmail();$('mailState').textContent='Enviando… No repitas el envío.';
  try { const result=await api('MAIL_SEND',{id,mail:{...value,confirm:true}});if(generation===mailGeneration)$('mailState').textContent=mailStatus(result.state); }
  catch(e){if(generation===mailGeneration)$('mailState').textContent=errors[e.message] || 'No se confirmó el envío. Revisá el historial y tu casilla antes de reenviar. Reintentar el mismo correo no duplica el intento.';}
  finally{mailPending=false;$('mailEdit').disabled=false;$('mailClose').disabled=false;if(generation===mailGeneration)$('mailNewAttempt').hidden=false;}
};
(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id; await run(refresh); })();
