// Asisto | Version: 5.00.130 | Fecha: 2026-09-12
(() => {
  let chats = [], knownChats = [], owner = '', timer, stopped = false, currentJid = '', currentName = '', taskData = { tasks: [], messages: [] }, anchorId = '', selectionDirty = false;
  const remembered = new Map(), addressBook = [], selected = new Set();
  const extractJid = value => ((value || '').match(/(?:^|_)([0-9]+@(?:s\.whatsapp\.net|c\.us|lid))(?:_|$)/)?.[1] || '').replace('@c.us', '@s.whatsapp.net');
  const extractMessageId = value => {
    const raw = String(value || '');
    return raw.match(/^(?:true|false)_[^_]+_(.+)$/)?.[1] || raw.match(/(?:^|_)([A-Za-z0-9-]{10,})$/)?.[1] || '';
  };
  function messageAt(value) {
    const match = String(value || '').match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/); if (!match) return NaN;
    const year = Number(match[5]) < 100 ? 2000 + Number(match[5]) : Number(match[5]);
    return +new Date(year, Number(match[4]) - 1, Number(match[3]), Number(match[1]), Number(match[2]));
  }
  const statusLabel = status => ({ pending: 'Pendiente', saved: 'HubSpot', discarded: 'Descartada' }[status] || 'Asignada');
  function messageNodes() {
    const seenNodes = new Set(), seenIds = new Set(), usedRows = new Set(), result = [];
    const candidates = [...document.querySelectorAll('#main .message-in, #main .message-out, #main [data-id^="true_"], #main [data-id^="false_"], #main [data-pre-plain-text], #main [role="row"]')].filter(node => !node.closest('[data-asisto-owned]') && (!node.matches('[role="row"]') || node.querySelector('[data-pre-plain-text], audio, [data-icon*="audio"], [data-testid*="audio"], [data-icon="ptt-status"]')));
    for (const candidate of candidates) {
      
      const message = candidate.closest('.message-in, .message-out') || (candidate.matches('.message-in, .message-out') ? candidate : null);
      const node = candidate.closest('[data-id^="true_"], [data-id^="false_"]') || message || candidate.closest('[role="row"]') || candidate;
      if (seenNodes.has(node)) continue;
      const idNode = node.matches('[data-id^="true_"], [data-id^="false_"]') ? node : node.querySelector('[data-id^="true_"], [data-id^="false_"]'), pre = node.matches('[data-pre-plain-text]') ? node : node.querySelector('[data-pre-plain-text]');
      let id = extractMessageId(idNode?.getAttribute('data-id'));
      if (!id) {
        const at = messageAt(pre?.getAttribute('data-pre-plain-text')), fromMe = node.classList.contains('message-out') || !!node.closest('.message-out') || !!node.querySelector('.message-out');
        const match = (taskData.messages || []).find(row => !usedRows.has(row.waId) && row.fromMe === fromMe && Math.abs(+new Date(row.at) - at) < 60000);
        id = match?.waId || '';
      }
      if (id && seenIds.has(id)) continue; seenNodes.add(node); if (id) { seenIds.add(id); usedRows.add(id); } node.dataset.asistoMessageId = id; node.classList.add('asisto-message-anchor'); result.push(node);
    }
    return result;
  }
  function renderMessageControls() {
    const assignments = new Map((taskData.messages || []).map(row => [row.waId, row])), nodes = messageNodes(), retained = new Set();
    const main = document.querySelector('#main'), mainRect = main?.getBoundingClientRect();
    document.querySelectorAll('.asisto-message-control').forEach(holder => holder.remove());
    if (taskData.excluded) { selected.clear(); document.querySelector('.asisto-message-toolbar')?.remove(); return; }
    for (const node of nodes) {
      const id = node.dataset.asistoMessageId, row = assignments.get(id), holder = document.createElement('div'), rect = node.getBoundingClientRect();
      holder.className = 'asisto-message-control'; holder.dataset.asistoOwned = '1'; holder.replaceChildren();
      holder.style.top = Math.max(4, rect.top - (mainRect?.top || 0) + rect.height / 2 - 11) + 'px';
      const rowAssignments = row?.assignments || [];
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!id && (selected.has(id) || rowAssignments.length > 0); check.disabled = !id || (rowAssignments.length > 0 && !selected.has(id)); check.title = 'Seleccionar mensaje para una tarea';
      check.classList.toggle('assigned', rowAssignments.length > 0);
      check.title = rowAssignments.length ? rowAssignments.map(assignment => `${statusLabel(assignment.status)} · ${assignment.subject || assignment.shortId}`).join('\n') : 'Seleccionar este mensaje para una tarea';
      if (!id) check.title = 'Esperando que Baileys sincronice este mensaje';
      check.setAttribute('aria-label', check.title); check.onchange = event => { event.stopPropagation(); selectionDirty = true; anchorId = id; check.checked ? selected.add(id) : selected.delete(id); renderToolbar(); }; check.onclick = event => event.stopPropagation(); holder.append(check);
      for (const assignment of row?.assignments || []) {
        const badge = document.createElement('button'); badge.type = 'button'; badge.className = `asisto-message-assignment ${assignment.status}`;
        badge.textContent = `${statusLabel(assignment.status)} · ${assignment.subject || assignment.shortId}`; badge.title = `Tarea ${assignment.shortId}${assignment.ticketId ? ' · Ticket ' + assignment.ticketId : ''}`;
        badge.onclick = event => { event.preventDefault(); event.stopPropagation(); chrome.runtime.sendMessage({ action: 'OPEN', jid: currentJid, name: currentName, draftId: assignment.draftId }).catch(() => {}); }; holder.append(badge);
      }
      main?.append(holder); retained.add(holder);
    }
    document.querySelectorAll('.asisto-message-control').forEach(holder => { if (!retained.has(holder)) holder.remove(); }); renderToolbar(nodes);
  }
  function destinationOptions(select) {
    const tasks = taskData.tasks || [], pending = tasks.filter(task => task.status === 'pending');
    const add = (value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); };
    if (pending.length > 1) add('', 'Elegí una tarea'); add('new', 'Nueva tarea');
    for (const task of tasks) add(task.id, `${task.subject} · ${statusLabel(task.status)}${task.ticketId ? ' #' + task.ticketId : ''}`);
    select.value = pending.length === 1 ? pending[0].id : pending.length === 0 ? 'new' : '';
  }
  function renderToolbar(nodes = messageNodes()) {
    let bar = document.querySelector('.asisto-message-toolbar'); if (!nodes.length || !selected.size) { bar?.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'asisto-message-toolbar'; bar.dataset.asistoOwned = '1'; const main = document.querySelector('#main'), footer = main?.querySelector('footer'); if (footer) footer.parentElement.insertBefore(bar, footer); else main?.append(bar); }
    const previousDestination = bar.querySelector('select')?.value, previousAction = bar.querySelectorAll('select')[1]?.value;
    bar.replaceChildren(); const title = document.createElement('strong'); title.textContent = `Asisto · ${selected.size} seleccionados`;
    const all = document.createElement('button'); all.textContent = 'Todos'; all.onclick = () => { nodes.forEach(node => { if (node.dataset.asistoMessageId) selected.add(node.dataset.asistoMessageId); }); renderMessageControls(); };
    const none = document.createElement('button'); none.textContent = 'Ninguno'; none.onclick = () => { selected.clear(); renderMessageControls(); };
    const from = document.createElement('button'); from.textContent = 'Desde aquí'; from.disabled = !anchorId; from.onclick = () => { const index = nodes.findIndex(node => node.dataset.asistoMessageId === anchorId); if (index >= 0) nodes.slice(index).forEach(node => { if (node.dataset.asistoMessageId) selected.add(node.dataset.asistoMessageId); }); renderMessageControls(); };
    const destination = document.createElement('select'); destinationOptions(destination); if (previousDestination !== undefined && [...destination.options].some(option => option.value === previousDestination)) destination.value = previousDestination;
    const action = document.createElement('select'); [['','Acción sobre ticket'],['followup','Agregar seguimiento'],['update','Actualizar ticket existente']].forEach(([value,label]) => { const item=document.createElement('option'); item.value=value; item.textContent=label; action.append(item); });
    if (previousAction) action.value = previousAction;
    destination.onchange = () => { action.hidden = !(taskData.tasks || []).find(task => task.id === destination.value)?.ticketId; }; destination.onchange();
    const assign = document.createElement('button'); assign.className = 'primary'; assign.textContent = destination.value === 'new' ? 'Crear tarea con seleccionados' : 'Actualizar tarea con seleccionados'; destination.onchange = () => { action.hidden = !(taskData.tasks || []).find(task => task.id === destination.value)?.ticketId; assign.textContent = destination.value === 'new' ? 'Crear tarea con seleccionados' : 'Actualizar tarea con seleccionados'; }; destination.onchange(); assign.onclick = async () => {
      if (!currentJid) return alert('Todavía no se pudo identificar este contacto. Esperá a que se cargue su información y volvé a intentar.');
      if (!selected.size) return alert('Seleccioná al menos un mensaje.'); if (!destination.value) return alert('Elegí la tarea de destino.');
      const saved = (taskData.tasks || []).find(task => task.id === destination.value)?.ticketId; if (saved && !action.value) return alert('Elegí si querés agregar un seguimiento o actualizar el ticket existente.');
      const selectedMessages = messageNodes().filter(node => selected.has(node.dataset.asistoMessageId)).map(node => {
        const pre = node.matches('[data-pre-plain-text]') ? node : node.querySelector('[data-pre-plain-text]');
        const at = messageAt(pre?.getAttribute('data-pre-plain-text'));
        const parts = [...node.querySelectorAll('.selectable-text')].filter(element => !element.parentElement?.closest('.selectable-text')).map(element => element.innerText || element.textContent || '');
        return { id: node.dataset.asistoMessageId, jid: currentJid, at: Number.isFinite(at) ? new Date(at).toISOString() : '', fromMe: node.classList.contains('message-out') || !!node.querySelector('.message-out') || node.getAttribute('data-id')?.startsWith('true_') === true, text: parts.join('\n').trim() };
      });
      const request = { action: 'ASSIGN_MESSAGES', jid: currentJid, messageIds: [...selected], selectedMessages, destination: destination.value, existingAction: action.value };
      chrome.runtime.sendMessage({ action: 'OPEN', jid: currentJid, name: currentName }).catch(() => {});
      assign.disabled = true; assign.textContent = 'Preparando tarea…';
      let response; try { response = await chrome.runtime.sendMessage(request); } catch { response = { error: 'No se pudo comunicar con Asisto. Volvé a intentar.' }; } finally { assign.disabled = false; }
      if (response?.error === 'message_already_assigned' && confirm('Uno o más mensajes ya pertenecen a otra tarea. ¿Querés reasignarlos?')) response = await chrome.runtime.sendMessage({ ...request, reassign: true });
      if (response?.error) { renderToolbar(); return alert(response.error === 'message_selection_not_found' ? 'Falta sincronizar algún mensaje seleccionado y no se pudo recuperar su texto o fecha. Mantené esos mensajes visibles y volvé a intentar. Para audios sin transcripción, esperá a que Baileys los procese.' : 'Asisto: ' + response.error); } selectionDirty = false; selected.clear(); await refreshTasks(); chrome.runtime.sendMessage({ action: 'SET_CONTEXT', jid: currentJid, name: currentName }).catch(() => {});
    };
    bar.append(title, all, none, from, destination, action, assign);
  }
  async function refreshTasks() {
    if (!currentJid) return; const requestedJid = currentJid; const response = await chrome.runtime.sendMessage({ action: 'MESSAGES', jid: requestedJid }); if (!response?.data || currentJid !== requestedJid) return; taskData = response.data;
    if (!selectionDirty) selected.clear();
    renderMessageControls();
  }
  function update() {
    if (stopped) return; observer.disconnect(); const targets = [...document.querySelectorAll('#pane-side [role="row"], #pane-side [role="listitem"], #main header')], retained = new Set();
    for (const target of targets) {
      if (target.closest('[data-asisto-owned]')) continue; const label = target.querySelector('span[title][dir="auto"], span[title]') || (target.matches('#main header') ? target.querySelector('span[dir="auto"]') : null); if (!label) continue;
      const jid = extractJid(target.getAttribute('data-id') || target.querySelector('[data-id]')?.getAttribute('data-id')) || (target.matches('#main header') ? [...document.querySelectorAll('#main [data-id]')].map(node => extractJid(node.getAttribute('data-id'))).find(Boolean) || '' : ''), name = label.getAttribute('title') || label.textContent.trim();
      if (jid && name && remembered.get(jid) !== name) { remembered.set(jid, name); chrome.runtime.sendMessage({ action: 'CONTACT', jid, name }).then(result => { if (result?.data?.saved) refresh(); else if (result?.error) remembered.delete(jid); }).catch(() => {}); }
      const match = AsistoMatch.matchContact(chats, { jid, name }), known = AsistoMatch.matchContact(knownChats, { jid, name }); let button = target.querySelector('.asisto-task-badge');
      const localContact = AsistoMatch.matchContact(addressBook.map(contact => ({ jid: contact.aliases[0], aliases: contact.aliases, name: contact.name, count: 0 })), { jid, name });
      const activeJid = target.matches('#main header') ? (jid || known?.jid || localContact?.jid || '') : '';
      if (target.matches('#main header') && (currentJid !== activeJid || currentName !== name)) { currentJid = activeJid; currentName = name; taskData = { tasks: [], messages: [] }; selected.clear(); selectionDirty = false; anchorId = ''; chrome.runtime.sendMessage({ action: 'SET_CONTEXT', jid: currentJid, name: currentName }).catch(() => {}); if (currentJid) refreshTasks().catch(() => {}); }
      if (!match) { button?.remove(); continue; }
      if (!button) { button = document.createElement('button'); button.className = 'asisto-task-badge'; button.type = 'button'; button.dataset.asistoOwned = '1'; button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (event.isTrusted) chrome.runtime.sendMessage({ action: 'OPEN', jid: button.dataset.jid, name: button.dataset.name }).catch(() => {}); }); label.insertAdjacentElement('afterend', button); }
      const currentCount = match.jid === currentJid ? (taskData.tasks || []).filter(task => task.status === 'pending').length : match.count;
      button.dataset.jid = match.jid; button.dataset.name = match.name; button.textContent = '✓ ' + currentCount; button.title = `Asisto: ${currentCount} tarea${currentCount === 1 ? '' : 's'}. Revisar resumen`; button.setAttribute('aria-label', button.title); retained.add(button);
    }
    document.querySelectorAll('.asisto-task-badge').forEach(button => { if (!retained.has(button)) button.remove(); }); renderMessageControls(); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'data-id'] });
  }
  const observer = new MutationObserver(records => { if (records.every(record => record.target.closest?.('[data-asisto-owned]') || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && node.matches?.('[data-asisto-owned]'))))) return; clearTimeout(timer); timer = setTimeout(update, 180); });
  async function refresh() { try { const result = await chrome.runtime.sendMessage({ action: 'INDEX' }); if (owner !== result?.data?.owner) remembered.clear(); owner = result?.data?.owner || ''; chats = result?.data?.chats || []; knownChats = result?.data?.knownChats || chats; } catch { chats = []; knownChats = []; if (!chrome.runtime?.id) stopped = true; } update(); syncAddressBook(); }
  function syncAddressBook() { if (!chats.length || !addressBook.length) return; const found = new Map(); for (const contact of addressBook) for (const alias of contact.aliases || []) { const chat = chats.find(item => item.jid === alias || item.aliases?.includes(alias)); if (chat && contact.name) found.set(chat.jid, { jid: chat.jid, name: contact.name, aliases: contact.aliases }); } const pending = [...found.values()].filter(contact => remembered.get(contact.jid) !== contact.name); if (!pending.length) return; pending.forEach(contact => remembered.set(contact.jid, contact.name)); for (let offset = 0; offset < pending.length; offset += 50) chrome.runtime.sendMessage({ action: 'CONTACTS', contacts: pending.slice(offset, offset + 50) }).then(result => { if (result?.error) pending.slice(offset, offset + 50).forEach(contact => remembered.delete(contact.jid)); else refresh(); }).catch(() => pending.slice(offset, offset + 50).forEach(contact => remembered.delete(contact.jid))); }
  window.addEventListener('message', event => { if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'asisto-whatsapp-contacts-v1' || !Array.isArray(event.data.contacts)) return; for (const contact of event.data.contacts) if (typeof contact?.name === 'string' && Array.isArray(contact.aliases)) addressBook.push(contact); update(); syncAddressBook(); });
  document.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(renderMessageControls, 80); }, true);
  refresh(); const interval = setInterval(() => { if (stopped) clearInterval(interval); else { refresh(); refreshTasks().catch(() => {}); } }, 30000);
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.contactControlUpdated) { refresh(); refreshTasks().catch(() => {}); } });
})();
