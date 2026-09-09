// Asisto | Version: 5.00.082 | Fecha: 2026-09-09
(() => {
  if (window.__asistoHubspotRunning) return;
  window.__asistoHubspotRunning = true;
  const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const visible = element => !!(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(test, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = test(); if (result) return result; await sleep(250); }
    return null;
  }
  function status(message, failed = false) {
    let box = document.getElementById('asisto-hubspot-status');
    if (!box) { box = document.createElement('div'); box.id = 'asisto-hubspot-status'; Object.assign(box.style, { position:'fixed', right:'20px', bottom:'20px', zIndex:'2147483647', maxWidth:'380px', padding:'14px 18px', borderRadius:'10px', color:'#fff', font:'600 14px system-ui', boxShadow:'0 8px 30px #0005' }); document.documentElement.append(box); }
    box.style.background = failed ? '#b42318' : '#087f5b'; box.textContent = message;
  }
  const exactText = (labels, selector = 'button,[role="button"]') => {
    const wanted = labels.map(norm);
    return [...document.querySelectorAll(selector)].find(element => visible(element) && wanted.includes(norm(element.textContent || element.getAttribute('aria-label'))));
  };
  const matchingText = (labels, selector = 'button,[role="button"]') => {
    const wanted = labels.map(norm);
    return [...document.querySelectorAll(selector)].find(element => {
      const value = norm(element.textContent || element.getAttribute('aria-label'));
      return visible(element) && wanted.some(label => value === label || value.startsWith(label + ' '));
    });
  };
  const clickableText = labels => {
    const wanted = labels.map(norm), walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!wanted.some(label => { const value = norm(node.nodeValue); return value === label || value.startsWith(label + ' '); })) continue;
      const element = node.parentElement?.closest('button,a,[role="button"],[role="menuitem"],[tabindex]');
      if (visible(element)) return element;
    }
    return null;
  };
  function control(labels) {
    const wanted = labels.map(norm);
    for (const element of document.querySelectorAll('label,[data-test-id],[data-selenium-test],[aria-label]')) {
      const own = norm(element.tagName === 'LABEL' ? element.textContent : element.getAttribute('aria-label') || element.textContent);
      if (!wanted.some(label => own === label || own.startsWith(label + ' '))) continue;
      const target = element.htmlFor && document.getElementById(element.htmlFor) || element.matches('input,textarea,button,[role="combobox"],[contenteditable="true"]') && element || element.querySelector('input,textarea,button,[role="combobox"],[contenteditable="true"]') || element.parentElement?.querySelector('input,textarea,button,[role="combobox"],[contenteditable="true"]');
      if (visible(target)) return target;
    }
    return [...document.querySelectorAll('input,textarea,button,[role="combobox"],[contenteditable="true"]')].find(element => visible(element) && wanted.includes(norm(element.getAttribute('aria-label') || element.getAttribute('placeholder'))));
  }
  function setText(element, value) {
    element.focus();
    if (element.isContentEditable) { element.textContent = value; element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value })); }
    else {
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles:true })); element.dispatchEvent(new Event('change', { bubbles:true }));
    }
  }
  async function setChoice(labels, value) {
    const element = control(labels); if (!element) return false;
    element.click();
    const wanted = norm(value);
    const option = await waitFor(() => [...document.querySelectorAll('[role="option"],li,button')].find(item => visible(item) && norm(item.textContent) === wanted), 5000);
    if (!option) return false; option.click(); return true;
  }
  async function fill(job) {
    status('Asisto está preparando el ticket…');
    let subject = control(['Nombre del ticket','Nombre de ticket','Ticket name','Nombre']);
    if (!subject) {
      let create = matchingText(['Crear ticket','Crear un ticket','Crear nuevo ticket','Create ticket']);
      if (!create) {
        const add = matchingText(['Agregar tickets','Agregar ticket','Add tickets','Add ticket']) || clickableText(['Agregar tickets','Agregar ticket','Add tickets','Add ticket']);
        if (add) {
          add.click();
          create = await waitFor(() => matchingText(['Crear ticket','Crear un ticket','Crear nuevo ticket','Create ticket','Nuevo ticket','New ticket'], '[role="menuitem"],button,a,[role="button"]'), 5000);
        }
      }
      if (!create) {
        const tickets = exactText(['Tickets'], 'a,button,[role="button"]');
        if (tickets) {
          tickets.click();
          create = await waitFor(() => matchingText(['Crear ticket','Crear un ticket','Crear nuevo ticket','Create ticket']), 15000);
          if (!create) {
            const add = matchingText(['Agregar tickets','Agregar ticket','Add tickets','Add ticket']) || clickableText(['Agregar tickets','Agregar ticket','Add tickets','Add ticket']);
            if (add) { add.click(); create = await waitFor(() => matchingText(['Crear ticket','Crear un ticket','Crear nuevo ticket','Create ticket','Nuevo ticket','New ticket'], '[role="menuitem"],button,a,[role="button"]'), 5000); }
          }
        }
      }
      if (!create) throw new Error('Abrí la sección Tickets de HubSpot y volvé a pulsar Guardar para HubSpot.');
      create.click(); subject = await waitFor(() => control(['Nombre del ticket','Nombre de ticket','Ticket name','Nombre']), 15000);
    }
    if (!subject) throw new Error('No se encontró el formulario de creación de tickets.');
    const fields = job.fields || {}, missing = [];
    setText(subject, fields.subject || 'Tarea de WhatsApp');
    const description = control(['Descripción del ticket','Descripcion del ticket','Descripción','Description','Contenido del ticket']);
    if (description) setText(description, ['Contacto de WhatsApp: ' + (fields.contact || ''), 'Empresa: ' + (fields.company || ''), '', fields.description || ''].join('\n'));
    for (const item of [
      [['Estado del ticket','Estado','Ticket status'], fields.status, 'estado'],
      [['Categoría','Categoria','Category'], fields.category, 'categoría'],
      [['Error tipo','Tipo de error','Error type'], fields.errorType, 'tipo de error'],
      [['Vía de contacto','Via de contacto','Canal','Channel'], fields.channel, 'vía de contacto'],
    ]) if (item[1] && !await setChoice(item[0], item[1])) missing.push(item[2]);
    for (const item of [[['Empresa','Company'], fields.company], [['Contacto','Contact'], fields.contact]]) {
      if (!item[1]) continue;
      const picker = control(item[0]); if (!picker) continue; picker.click();
      const input = await waitFor(() => [...document.querySelectorAll('input')].find(el => visible(el) && /buscar|search/.test(norm(el.placeholder))), 2000);
      if (input) { setText(input, item[1]); const result = await waitFor(() => [...document.querySelectorAll('[role="option"],li')].find(el => visible(el) && norm(el.textContent).includes(norm(item[1]))), 4000); if (result) result.click(); }
    }
    if (missing.length) throw new Error('HubSpot no mostró estos campos en el formulario: ' + missing.join(', ') + '. Agregalos al formulario de creación de tickets.');
    const submit = exactText(['Crear','Crear ticket','Create','Create ticket','Guardar','Save']);
    if (!submit) throw new Error('No se encontró el botón para crear el ticket.');
    submit.click();
    const success = await waitFor(() => /ticket (creado|created)|se creo el ticket/.test(norm(document.body.innerText)) || !document.contains(subject), 20000);
    if (!success) throw new Error('HubSpot no confirmó la creación del ticket.');
    const ticketId = location.href.match(/\/record\/0-5\/(\d+)/)?.[1] || 'manual';
    const result = await chrome.runtime.sendMessage({ action:'HUBSPOT_UI_COMPLETE', id:job.id, ticketId });
    if (result?.error) throw new Error(result.error);
    status('Ticket guardado en HubSpot. La tarea fue cerrada en Asisto.');
  }
  chrome.runtime.sendMessage({ action:'HUBSPOT_UI_READY' }).then(response => {
    if (response?.data) return fill(response.data);
  }).catch(async error => {
    window.__asistoHubspotRunning = false;
    status(error.message || 'No se pudo completar el ticket.', true);
    await chrome.runtime.sendMessage({ action:'HUBSPOT_UI_FAILED', error:error.message }).catch(() => {});
  });
})();
