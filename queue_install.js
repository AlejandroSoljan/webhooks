// Asisto | Mecan: invitación de instalación y traslado del turno | 2026-10-27
'use strict';

function handoffDuration(purpose) {
  if (purpose && purpose !== 'install') {
    const error = new Error('Destino de vinculación inválido.'); error.status = 400; throw error;
  }
  return purpose === 'install' ? 2 * 60 * 60 * 1000 : 3 * 60 * 1000;
}

function restoreMecanInstallReturn(ticketId) {
  if (TENANT !== 'MCN' || window.AsistoNative || !/Android/i.test(navigator.userAgent) || !ticketId) return;
  let transfer;
  try { transfer = JSON.parse(localStorage.getItem('mecanInstallTransfer:' + ticketId) || 'null'); } catch (_) {}
  if (!/^[A-Za-z0-9_-]{43}$/.test(transfer?.code || '') || +new Date(transfer.expiresAt) <= Date.now()) return;
  let button = document.getElementById('mecanInstallReturn');
  if (!button) { button = document.createElement('button'); button.id = 'mecanInstallReturn'; button.type = 'button'; el('my').append(button); }
  button.style.cssText = 'display:block;margin:12px auto;min-height:44px;border:1px solid #e00000;border-radius:12px;background:#fff;color:#b00016;padding:10px 14px;font:600 13px system-ui';
  button.textContent = 'Ya instalé Mecan · Abrir mi turno';
  button.onclick = () => {
    const claimUrl = new URL('/customer-app/MCN', 'https://asistobot.com.ar');
    claimUrl.searchParams.set('claim', ticketId); claimUrl.searchParams.set('view', 'ticket');
    claimUrl.hash = new URLSearchParams({ code: transfer.code }).toString();
    location.href = 'asisto://turno?url=' + encodeURIComponent(claimUrl.href);
  };
}

function offerMecanInstall(ticket) {
  if (TENANT !== 'MCN' || !MECAN_INSTALL_PROMPT_ENABLED || window.AsistoNative ||
      !/Android/i.test(navigator.userAgent) || !ticket?.id ||
      !['WAITING', 'CALLED'].includes(ticket.status)) return;
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
      const key = 'mecanInstallTransfer:' + ticket.id;
      let transfer;
      try { transfer = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
      if (!transfer?.code || +new Date(transfer.expiresAt) < Date.now() + 60000) {
        const response = await fetch(API + '/tickets/' + encodeURIComponent(ticket.id) + '/handoff', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ installId, purpose: 'install' })
        });
        transfer = await response.json();
        if (!response.ok) throw Error(transfer.error || 'No se pudo preparar la instalación.');
        if (!/^[A-Za-z0-9_-]{43}$/.test(transfer.code || '') || !Number.isFinite(+new Date(transfer.expiresAt))) throw Error('No se pudo guardar el turno para la app.');
        try { localStorage.setItem(key, JSON.stringify(transfer)); } catch (_) {}
      }
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

module.exports = { handoffDuration, offerMecanInstall, restoreMecanInstallReturn };
