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
    message.textContent = 'Tu turno está vinculado a Asisto. Permití las notificaciones de la app: te avisamos cuando faltan 2 turnos, 1 y cuando te llamen.'; box.append(message);
  } else {
    message.textContent = 'Tu turno está guardado en este celular. Mantené esta página abierta: te avisaremos cuando seas el próximo y cuando te llamen.';
    const button = document.createElement('button'); button.className = 'action'; button.textContent = ticketAlertsEnabled ? 'Avisos automáticos activados' : 'Activar sonido y vibración'; button.disabled = ticketAlertsEnabled;
    button.onclick = async () => { const enabled = await enableTicketAlerts(); button.textContent = enabled ? 'Avisos activados' : 'No se pudo activar el sonido'; button.disabled = enabled; if (enabled) { localStorage.removeItem('asistoLastTicketAlert'); refreshTicket().catch(()=>{}); } };
    box.append(message, button);
  }
  el('my').append(box);
}

async function enableTicketAlerts() {
  try {
    ticketAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    await ticketAudioContext.resume();
    ticketAlertsEnabled = ticketAudioContext.state === 'running';
    if (ticketAlertsEnabled) sessionStorage.asistoTicketAlerts = '1';
    if (ticketAlertsEnabled) {
      const oscillator=ticketAudioContext.createOscillator(),gain=ticketAudioContext.createGain(),start=ticketAudioContext.currentTime;
      oscillator.connect(gain);gain.connect(ticketAudioContext.destination);oscillator.frequency.value=820;gain.gain.setValueAtTime(.14,start);gain.gain.exponentialRampToValueAtTime(.001,start+.25);oscillator.start(start);oscillator.stop(start+.26);
    }
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    if (navigator.vibrate) navigator.vibrate(80);
    return ticketAlertsEnabled;
  } catch (_) { return false; }
}
function ticketAlert(ticket) {
  const kind = ticket.status === 'CALLED' ? 'called' : ticket.status === 'WAITING' && ticket.peopleAhead === 0 ? 'next' : '';
  if (!kind) return;
  const key = [ticket.id, kind, ticket.calledAt || ''].join(':');
  if (localStorage.asistoLastTicketAlert === key) return;
  localStorage.asistoLastTicketAlert = key;
  const title = kind === 'called' ? '¡Es tu turno!' : 'Sos el próximo';
  const detail = kind === 'called' ? (ticket.desk ? 'Acercate a ' + ticket.desk + '.' : 'Acercate al sector.') : 'Preparáte, enseguida te llamamos.';
  toast(title + ' ' + detail, 9000);
  document.title = title + ' · Asisto';
  if (navigator.vibrate) navigator.vibrate(kind === 'called' ? [350, 150, 350, 150, 600] : [220, 120, 220]);
  if (ticketAlertsEnabled && ticketAudioContext) {
    const frequencies = kind === 'called' ? [740, 940, 740] : [660, 820];
    frequencies.forEach((frequency, index) => { const oscillator=ticketAudioContext.createOscillator(),gain=ticketAudioContext.createGain(),start=ticketAudioContext.currentTime+index*.3;oscillator.connect(gain);gain.connect(ticketAudioContext.destination);oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.16,start);gain.gain.exponentialRampToValueAtTime(.001,start+.22);oscillator.start(start);oscillator.stop(start+.23); });
  }
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body: detail, tag: 'asisto-turno-' + ticket.id, renotify: true });
}
function armDefaultTicketAlerts() {
  ticketAlertsEnabled = true;
  sessionStorage.asistoTicketAlerts = '1';
  let unlocking = false;
  const unlock = async () => {
    if (unlocking || ticketAudioContext?.state === 'running') return;
    unlocking = true;
    const enabled = await enableTicketAlerts();
    unlocking = false;
    const button = document.querySelector('#ticketNotices button');
    if (button) { button.textContent = enabled ? 'Avisos automáticos activados' : 'Tocá para activar el sonido'; button.disabled = enabled; }
    if (enabled) { localStorage.removeItem('asistoLastTicketAlert'); refreshTicket().catch(()=>{}); }
  };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });
}
module.exports = { linkReservedTicket, setupTicketNotices, enableTicketAlerts, ticketAlert, armDefaultTicketAlerts };
