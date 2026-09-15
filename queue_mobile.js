// Asisto | Asociar una reserva al navegador o a la app Android | 2026-09-14
async function linkReservedTicket() {
  const id = new URLSearchParams(location.search).get('claim');
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  if (!id || !code) return false;
  only('my'); el('sectorLabel').textContent = 'Guardando tu turno en este celular…'; el('ticketNumber').textContent = '…';
  try {
    const r = await fetch(API + '/tickets/' + encodeURIComponent(id) + '/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, installId }) });
    const x = await r.json(); if (!r.ok) throw Error(x.error || 'No se pudo vincular el turno');
    localStorage.asistoTicketId = x.id;
    claimPending = false;
    history.replaceState(null, '', location.pathname + '?view=ticket');
    await refreshTicket();
    setupTicketNotices();
  } catch (e) { el('sectorLabel').textContent = 'No se pudo guardar el turno'; el('ticketNumber').textContent = '—'; el('ahead').textContent = e.message; }
  return true;
}
function setupTicketNotices() {
  if (!localStorage.asistoTicketId || el('ticketNotices')) return;
  const box = document.createElement('div'); box.id = 'ticketNotices'; box.style.cssText = 'padding:18px;margin-top:18px;border-radius:14px;background:#eef7f2';
  const message = document.createElement('p'); message.style.cssText = 'font-size:15px';
  if (window.AsistoNative) {
    message.textContent = 'Tu turno está vinculado a Asisto. Permití las notificaciones de la app para recibir el llamado.'; box.append(message);
  } else {
    message.textContent = 'Tu turno ya está guardado. Mantené esta pantalla abierta para ver el llamado, o abrilo en la app Asisto para recibir avisos.';
    const button = document.createElement('button'); button.className = 'action'; button.textContent = 'Abrir mi turno en Asisto';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const id = localStorage.asistoTicketId;
        const r = await fetch(API + '/tickets/' + encodeURIComponent(id) + '/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installId }) });
        const x = await r.json(); if (!r.ok) throw Error(x.error || 'No se pudo abrir el turno');
        const url = new URL(location.pathname, location.origin); url.searchParams.set('claim', id); url.hash = 'code=' + x.code;
        location.href = 'asisto://turno?url=' + encodeURIComponent(url.href);
      } catch (e) { message.textContent = e.message; } finally { button.disabled = false; }
    };
    const download = document.createElement('a'); download.href = '/customer-app/download/android'; download.textContent = 'Instalar o actualizar Asisto para Android'; download.style.cssText = 'display:block;margin-top:14px;font-size:14px';
    box.append(message, button, download);
  }
  el('my').append(box);
}
module.exports = { linkReservedTicket, setupTicketNotices };
