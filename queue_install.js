// Asisto | Mecan: invitación de instalación y traslado del turno | 2026-10-27
'use strict';

function handoffDuration(purpose) {
  if (purpose && purpose !== 'install') {
    const error = new Error('Destino de vinculación inválido.'); error.status = 400; throw error;
  }
  return purpose === 'install' ? 2 * 60 * 60 * 1000 : 3 * 60 * 1000;
}

function mecanTicketAppIntent(ticketId, transfer) {
  if (!/^[a-f0-9]{24}$/i.test(ticketId || '') || !/^[A-Za-z0-9_-]{43}$/.test(transfer?.code || '')) throw Error('Vínculo inválido.');
  const claim = new URL('/customer-app/MCN', 'https://asistobot.com.ar');
  claim.searchParams.set('claim', ticketId); claim.searchParams.set('view', 'ticket');
  claim.hash = new URLSearchParams({code:transfer.code}).toString();
  const play = new URL('https://play.google.com/store/apps/details');
  play.searchParams.set('id', 'ar.com.asisto.mecan');
  play.searchParams.set('referrer', new URLSearchParams({mecan_ticket:ticketId,mecan_code:transfer.code}).toString());
  return 'intent://turno?url=' + encodeURIComponent(claim.href) + '#Intent;scheme=asisto;package=ar.com.asisto.mecan;S.browser_fallback_url=' + encodeURIComponent(play.href) + ';end';
}

async function prepareMecanTicketTransfer(ticket) {
  const key = 'mecanInstallTransfer:' + ticket.id;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
  if (/^[A-Za-z0-9_-]{43}$/.test(saved?.code || '') && +new Date(saved.expiresAt) > Date.now() + 60000) return saved;
  const pending = window.__mecanInstallTransfers ||= new Map();
  if (pending.has(ticket.id)) return pending.get(ticket.id);
  const request = (async () => {
    const response = await fetch(API + '/tickets/' + encodeURIComponent(ticket.id) + '/handoff', {
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({installId,purpose:'install'})
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'No se pudo preparar el turno.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.code || '') || !(+new Date(value.expiresAt) > Date.now())) throw Error('No se pudo guardar el turno para la app.');
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  })();
  pending.set(ticket.id, request);
  try { return await request; } finally { pending.delete(ticket.id); }
}

function restoreMecanInstallReturn(ticketId) {
  if (TENANT !== 'MCN' || window.AsistoNative || !/Android/i.test(navigator.userAgent) || !ticketId) return;
  if (localStorage.asistoTicketId && localStorage.asistoTicketId !== ticketId) return;
  let transfer;
  try { transfer = JSON.parse(localStorage.getItem('mecanInstallTransfer:' + ticketId) || 'null'); } catch (_) {}
  if (!/^[A-Za-z0-9_-]{43}$/.test(transfer?.code || '') || !(+new Date(transfer.expiresAt) > Date.now())) return;
  let button = document.getElementById('mecanInstallReturn');
  if (!button) { button = document.createElement('button'); button.id = 'mecanInstallReturn'; button.type = 'button'; el('my').append(button); }
  button.style.cssText = 'display:block;margin:12px auto;min-height:44px;border:1px solid #e00000;border-radius:12px;background:#fff;color:#b00016;padding:10px 14px;font:600 13px system-ui';
  button.textContent = 'Abrir mi turno en Mecan'; button.disabled=false; button.dataset.ticketId=ticketId;
  button.onclick = () => {
    if (+new Date(transfer.expiresAt) <= Date.now()) { button.disabled=true;button.textContent='Actualizá para abrir el turno';return; }
    location.href = mecanTicketAppIntent(ticketId, transfer);
  };
}

function offerMecanInstall(ticket) {
  if (TENANT !== 'MCN' || !MECAN_INSTALL_PROMPT_ENABLED || window.AsistoNative ||
      !/Android/i.test(navigator.userAgent) || !ticket?.id ||
      !['WAITING', 'CALLED'].includes(ticket.status)) return;
  const previousButton=document.getElementById('mecanInstallReturn');
  if(previousButton && previousButton.dataset.ticketId!==ticket.id)previousButton.disabled=true;
  // El intent se abre sin esperar una red dentro del gesto de clic.
  prepareMecanTicketTransfer(ticket).then(()=>restoreMecanInstallReturn(ticket.id)).catch(()=>{});
  const promptKey = 'mecanInstallOffered:' + ticket.id;
  try { if (sessionStorage.getItem(promptKey)) return; } catch (_) {}
  if (document.getElementById('mecanInstallPrompt')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'mecanInstallPrompt';
  dialog.setAttribute('aria-labelledby', 'mecanInstallTitle');
  dialog.setAttribute('aria-describedby', 'mecanInstallDescription');
  const style = document.createElement('style');
  style.textContent = '#mecanInstallPrompt{width:calc(100% - 32px);max-width:330px;border:0;border-radius:22px;padding:24px 20px 12px;color:#191b20;background:#fff;box-shadow:0 18px 55px #0004;font-family:system-ui,sans-serif;text-align:center}#mecanInstallPrompt::backdrop{background:#10131a77}#mecanInstallPrompt h2{font-size:21px;line-height:1.2;margin:0 0 9px;padding:0;font-weight:750}#mecanInstallPrompt p{font-size:13px;line-height:1.5;color:#6b7079;margin:0 0 17px}#mecanInstallPrompt .mecanInstallIcon{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:#fff0f1;color:#e00000;margin:0 auto 12px;font-size:25px}#mecanInstallPrompt .mecanInstallClose{position:absolute;top:7px;right:7px;width:36px;height:36px;border:0;background:none;color:#707681;font-size:24px}#mecanInstallPrompt .mecanInstallKeep{display:block;text-align:left;border-radius:12px;background:#f3f5f7;padding:12px;margin:0 0 17px;font-size:12px}#mecanInstallPrompt .mecanInstallKeep span{display:block;color:#6b737f;font-size:11px;margin-top:4px}#mecanInstallPrompt .mecanInstallAction{width:100%;min-height:48px;border:0;border-radius:12px;background:#e00000;color:#fff;font:700 14px system-ui;padding:12px}#mecanInstallPrompt .mecanInstallAction:disabled{opacity:.65}#mecanInstallPrompt .mecanInstallLater{width:100%;min-height:44px;border:0;background:none;color:#686f79;font:12px system-ui;padding:12px 0 4px}#mecanInstallPrompt .mecanInstallError{margin:12px 0 0;color:#a60016}#mecanInstallReturn{display:block;margin:12px auto;min-height:44px;border:1px solid #e00000;border-radius:12px;background:#fff;color:#b00016;padding:10px 14px;font:600 13px system-ui}';
  dialog.innerHTML = '<button class="mecanInstallClose" type="button" aria-label="Cerrar invitación">×</button><div class="mecanInstallIcon" aria-hidden="true">↓</div><h2 id="mecanInstallTitle">¿Querés instalar Mecan?</h2><p id="mecanInstallDescription">Seguí tu turno y recibí avisos<br>directamente en la app.</p><div class="mecanInstallKeep"><strong></strong><span>Al abrir la app, continuás con este mismo turno.</span></div><button class="mecanInstallAction" type="button">Instalar Mecan</button><button class="mecanInstallLater" type="button">Ahora no, seguir en la web</button><p class="mecanInstallError" role="status" aria-live="polite" hidden></p>';
  dialog.querySelector('.mecanInstallKeep strong').textContent = 'Tu turno ' + ticket.displayNumber + ' sigue con vos';
  document.head.append(style); document.body.append(dialog);
  const dismiss = () => { dialog.close(); dialog.remove(); style.remove(); };
  dialog.querySelector('.mecanInstallClose').onclick = dismiss;
  dialog.querySelector('.mecanInstallLater').onclick = dismiss;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.querySelector('.mecanInstallAction').onclick = async () => {
    const button = dialog.querySelector('.mecanInstallAction'), error = dialog.querySelector('.mecanInstallError');
    button.disabled = true; button.textContent = 'Guardando tu turno…'; error.hidden = true;
    try {
      const transfer = await prepareMecanTicketTransfer(ticket);
      const params = new URLSearchParams({ mecan_ticket: ticket.id, mecan_code: transfer.code });
      const playUrl = 'https://play.google.com/store/apps/details?id=ar.com.asisto.mecan&referrer=' + encodeURIComponent(params.toString());
      restoreMecanInstallReturn(ticket.id);
      dismiss();
      location.href = playUrl;
    } catch (e) {
      error.textContent = e.message || 'No se pudo guardar el turno. Podés continuar en esta página.'; error.hidden = false;
      button.disabled = false; button.textContent = 'Reintentar instalación';
    }
  };
  if (typeof dialog.showModal !== 'function') { dialog.remove(); style.remove(); return; }
  try { dialog.showModal(); sessionStorage.setItem(promptKey, '1'); } catch (_) {}
}

module.exports = { handoffDuration, offerMecanInstall, restoreMecanInstallReturn, prepareMecanTicketTransfer, mecanTicketAppIntent };
