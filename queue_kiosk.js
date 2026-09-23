// Asisto | Reserva, vinculación e impresión del mismo turno | 2026-09-14
function kiosk() {
  let pendingRequest = null, reserved = null, poll = null, polling = false, deadline = 0, printing = false, printRequestId = '';
  const requestId = () => globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  const dialog = $('ticketDialog');
  $('content').innerHTML = '<div class="layout"><section><div class="eyebrow">Paso 1 · Elegí tu sección</div><h1>¿En qué podemos<br>ayudarte hoy?</h1><p>Elegí dónde necesitás atención. Después llevá tu turno al celular.</p><div class="sectors" id="sectors"></div></section><aside class="mobile"><span class="pill">Más cómodo en tu celular</span><h2>Elegí tu sección.<br>Escaneá. Y listo.</h2><p>Te vamos a mostrar un QR exclusivo para guardar tu turno en el teléfono.</p><ol class="steps"><li>Seleccioná una sección.</li><li>Escaneá el QR de tu turno.</li><li>Seguí tu lugar desde el celular.</li></ol><div class="benefit">Recibí el llamado en tu celular<small>También podés llevarte un ticket impreso.</small></div><div id="promo"></div></aside></div>';
  cfg.sectors.forEach(s => { const b = button('', () => s.kind === 'presence' ? autoservice(s) : reserve(s)); b.className = 'sector'; b.append(element('span', s.name), element('b', s.kind === 'presence' ? '⌁' : '›')); $('sectors').append(b); });
  $('promo').textContent = cfg.queuePromotion || '';
  async function autoservice(s) {
    if (busy) return;
    setBusy(true);
    try {
      const x = await request(ADMIN + '/presence');
      reserved = null; deadline = Date.now() + Number(x.expiresIn || 90) * 1000;
      $('ticketSector').textContent = s.name;
      $('claimQr').src = x.image;
      $('deliveryTitle').textContent = 'Registrá tu ingreso';
      $('deliveryMessage').textContent = 'Escaneá este QR con tu celular. No genera turno ni ticket impreso.';
      $('claimHelp').textContent = 'Este QR registra tu visita al local y habilita la solicitud de turnos desde el celular durante 2 horas.';
      $('claimArea').hidden = false; $('printTicket').hidden = true; $('closeTicket').hidden = true;
      $('deliveryStatus').textContent = 'Después podrás solicitar turnos desde la web durante 2 horas.';
      $('deliveryError').textContent = '';
      dialog.showModal(); ok();
      clearInterval(poll); poll = setInterval(async () => {
        try {
          const status = await request(ADMIN + '/presence/' + encodeURIComponent(x.sessionId) + '/status');
          const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          $('countdown').textContent = 'El QR se actualiza en ' + seconds + ' segundos.';
          if (status.checkedIn) {
            clearInterval(poll); $('claimArea').hidden = true; $('closeTicket').hidden = false;
            $('deliveryTitle').textContent = 'Ingreso registrado';
            $('deliveryMessage').textContent = 'Ya podés solicitar turnos desde tu celular durante 2 horas.';
            $('deliveryStatus').textContent = '¡Bienvenido!'; $('countdown').textContent = '';
            closeTimer = setTimeout(close, 2000);
          } else if (seconds === 0) { clearInterval(poll); close(); }
        } catch (_) { $('deliveryError').textContent = 'No pudimos comprobar el ingreso. Reintentando…'; }
      }, 1000);
    } catch (e) { error(e); } finally { setBusy(false); }
  }
  async function reserve(s) {
    if (busy) return;
    if (pendingRequest && pendingRequest.sectorId !== s.id) { error(Error('Reintentá la sección anterior para recuperar tu reserva.')); return; }
    pendingRequest ||= { sectorId: s.id, installId: requestId(), source: 'kiosk', delivery: 'qr_or_print' };
    setBusy(true);
    try {
      const x = await request(API + '/tickets', { method: 'POST', body: JSON.stringify(pendingRequest) });
      pendingRequest = null;
      if (x.status !== 'RESERVED') { error(Error('Esta reserva ya se entregó o venció. Elegí nuevamente la sección.')); return; }
      reserved = x; deadline = Date.parse(x.reservationExpiresAt); printRequestId = '';
      $('ticketSector').textContent = x.sectorName;
      $('claimQr').src = x.claimQr;
      $('deliveryTitle').textContent = 'Llevá tu turno al celular';
      $('deliveryMessage').textContent = 'Escaneá este QR con la cámara. Tu turno se guarda en ese teléfono.';
      $('claimHelp').innerHTML = '<b>Te avisaremos en el celular cuando sea tu turno.</b> Mientras esperás, descubrí todo lo que podés hacer con Asisto.';
      $('claimArea').hidden = false; $('printTicket').hidden = false; $('printTicket').textContent = 'Imprimir ticket'; $('closeTicket').hidden = true;
      $('deliveryStatus').textContent = 'Esperando que escanees…';
      $('deliveryError').textContent = '';
      dialog.showModal(); ok();
      clearInterval(poll); poll = setInterval(checkDelivery, 2000); checkDelivery();
    } catch (e) { error(e); } finally { setBusy(false); }
  }
  async function checkDelivery() {
    if (!reserved || polling || printing) return;
    polling = true;
    try {
      const x = await request(ADMIN + '/tickets/' + reserved.id + '/delivery');
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      $('countdown').textContent = x.deliveryMode === 'print' ? 'Podés reintentar la impresión si la cancelaste.' : 'Tenés ' + seconds + ' segundos para guardar tu turno.';
      if (x.deliveryMode === 'print' && seconds === 0) { close(); return; }
      if (x.claimed) {
        clearInterval(poll); $('deliveryTitle').textContent = '¡Listo! Tu turno está en el celular';
        $('deliveryMessage').textContent = 'Podés seguirlo desde el teléfono. Para recibir avisos, abrilo en la app Asisto.';
        $('claimArea').hidden = true; $('printTicket').hidden = true; $('closeTicket').hidden = false;
        $('deliveryStatus').textContent = 'Turno vinculado correctamente'; $('countdown').textContent = '';
        closeTimer = setTimeout(close, 2000);
      } else if (x.status === 'CANCELLED') {
        clearInterval(poll); $('claimArea').hidden = true; $('printTicket').hidden = true; $('closeTicket').hidden = false;
        $('deliveryTitle').textContent = 'La reserva venció'; $('deliveryMessage').textContent = 'Volvé a elegir la sección para obtener un nuevo QR.';
        $('countdown').textContent = ''; $('deliveryStatus').textContent = '';
        closeTimer = setTimeout(close, 6000);
      }
    } catch (e) { $('deliveryError').textContent = 'No pudimos comprobar la vinculación. Reintentando…'; }
    finally { polling = false; }
  }
  async function printTicket() {
    if (!reserved || printing) return;
    printing = true; $('printTicket').disabled = true;
    try {
      printRequestId ||= requestId();
      const x = await request(ADMIN + '/tickets/' + reserved.id + '/print', { method: 'POST', body: JSON.stringify({ printRequestId, clientPrinter: 'local_http' }) });
      if (x.serverPrinted) {
        $('claimArea').hidden = true;
        $('deliveryTitle').textContent = 'Ticket impreso';
        $('deliveryMessage').textContent = 'Retirá tu comprobante y mirá la pantalla de llamados.';
        $('deliveryStatus').textContent = x.duplicatePrintRequest ? 'La solicitud ya había sido enviada a la impresora.' : 'Impresión enviada correctamente.';
        $('closeTicket').hidden = false; $('closeTicket').textContent = 'Listo';
        $('printTicket').hidden = true; $('printTicket').textContent = 'Imprimir ticket'; $('deliveryError').textContent = '';
        closeTimer = setTimeout(close, 2000);
        return;
      }
      const parts = Object.fromEntries(new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(x.createdAt)).map(part => [part.type, part.value]));
      const payload = { numero:x.displayNumber, seccion:x.sectorName, fecha:parts.day+'/'+parts.month+'/'+parts.year+' '+parts.hour+':'+parts.minute, qr:x.claimUrl };
      const localResponse = await fetch('http://127.0.0.1:9105/imprimir', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:AbortSignal.timeout(8000) });
      if (!localResponse.ok) throw Error('El servicio local de impresión respondió '+localResponse.status+'.');
      printRequestId = '';
      $('claimArea').hidden = true;
      $('deliveryTitle').textContent = 'Ticket impreso';
      $('deliveryMessage').textContent = 'Retirá tu comprobante y mirá la pantalla de llamados.';
      $('deliveryStatus').textContent = 'Impresión enviada correctamente.';
      $('closeTicket').hidden = false; $('closeTicket').textContent = 'Terminé';
      $('printTicket').hidden = true; $('printTicket').textContent = 'Imprimir ticket'; $('deliveryError').textContent = '';
      closeTimer = setTimeout(close, 2000);
    } catch (e) { $('deliveryError').textContent = e?.name === 'TimeoutError' ? 'El servicio local de impresión no respondió.' : (e.message || 'No se pudo conectar con la impresora local.'); }
    finally { printing = false; $('printTicket').disabled = false; }
  }
  async function dismiss() {
    if (!reserved || busy) { close(); return; }
    setBusy(true); $('dismissTicket').disabled = false;
    try {
      await request(ADMIN + '/tickets/' + reserved.id + '/cancel', { method: 'POST', body: '{}' });
      close();
    } catch (e) { $('deliveryError').textContent = 'No se pudo cerrar la reserva. Reintentá con la X.'; }
    finally { setBusy(false); }
  }
  function close() { clearInterval(poll); clearTimeout(closeTimer); reserved = null; dialog.close(); $('receipt').replaceChildren(); }
  dialog.addEventListener('cancel', e => { e.preventDefault(); dismiss(); });
  $('printTicket').onclick = printTicket; $('closeTicket').onclick = close; $('dismissTicket').onclick = dismiss;
}
module.exports = { kiosk };
