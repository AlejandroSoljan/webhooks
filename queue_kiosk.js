// Asisto | Reserva, vinculación e impresión del mismo turno | 2026-09-14
function kiosk() {
  let pendingRequest = null, reserved = null, poll = null, polling = false, deadline = 0, printing = false, printRequestId = '';
  const dialog = $('ticketDialog');
  $('content').innerHTML = '<div class="layout"><section><div class="eyebrow">Paso 1 · Elegí tu sección</div><h1>¿En qué podemos<br>ayudarte hoy?</h1><p>Elegí dónde necesitás atención. Después llevá tu turno al celular.</p><div class="sectors" id="sectors"></div></section><aside class="mobile"><span class="pill">Más cómodo en tu celular</span><h2>Elegí tu sección.<br>Escaneá. Y listo.</h2><p>Te vamos a mostrar un QR exclusivo para guardar tu turno en el teléfono.</p><ol class="steps"><li>Seleccioná una sección.</li><li>Escaneá el QR de tu turno.</li><li>Seguí tu lugar desde el celular.</li></ol><div class="benefit">Recibí el llamado en tu celular<small>También podés llevarte un ticket impreso.</small></div><div id="promo"></div></aside></div>';
  cfg.sectors.forEach(s => { const b = button('', () => reserve(s)); b.className = 'sector'; b.append(element('span', s.name), element('b', '›')); $('sectors').append(b); });
  $('promo').textContent = cfg.queuePromotion || '';
  async function reserve(s) {
    if (busy) return;
    if (pendingRequest && pendingRequest.sectorId !== s.id) { error(Error('Reintentá la sección anterior para recuperar tu reserva.')); return; }
    pendingRequest ||= { sectorId: s.id, installId: crypto.randomUUID(), source: 'kiosk', delivery: 'qr_or_print' };
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
      $('claimArea').hidden = false; $('printTicket').hidden = false; $('closeTicket').hidden = true;
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
        closeTimer = setTimeout(close, 6000);
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
      printRequestId ||= crypto.randomUUID();
      const x = await request(ADMIN + '/tickets/' + reserved.id + '/print', { method: 'POST', body: JSON.stringify({ printRequestId }) });
      printRequestId = '';
      if (x.serverPrinted) {
        $('claimArea').hidden = true;
        $('deliveryTitle').textContent = 'Ticket impreso';
        $('deliveryMessage').textContent = 'Retirá tu comprobante y mirá la pantalla de llamados.';
        $('deliveryStatus').textContent = x.duplicatePrintRequest ? 'La solicitud ya había sido enviada a la impresora.' : 'Impresión enviada correctamente.';
        $('closeTicket').hidden = false; $('closeTicket').textContent = 'Listo';
        $('printTicket').textContent = 'Volver a imprimir'; $('deliveryError').textContent = '';
        return;
      }
      const receipt = $('receipt'); receipt.replaceChildren();
      if(T==='DEMO_FERRETERIA'){const mark=element('img');mark.src='/customer-app/assets/mecan-logo.webp';mark.alt='Mecan';mark.className='receiptLogo';receipt.append(mark)}
      receipt.append(element('h2', x.businessName), element('p', x.sectorName), element('div', x.displayNumber, 'receiptNumber'), element('p', new Date(x.createdAt).toLocaleString('es-AR')), element('p', 'Mirá la pantalla de llamados.'), element('p', 'Conservá este número si te derivan a otra sección.'));
      const powered=element('div',undefined,'receiptPowered');powered.append(element('span','Powered by'));const asisto=element('img');asisto.src='/customer-app/assets/asisto-logo.png';asisto.alt='';powered.append(asisto,element('strong','Asisto'));receipt.append(powered,element('div','www.asistobot.com.ar'));
      $('deliveryStatus').textContent = 'Turno confirmado para imprimir';
      $('closeTicket').hidden = false; $('closeTicket').textContent = 'Terminé';
      $('printTicket').textContent = 'Volver a imprimir'; $('deliveryError').textContent = '';
      window.print();
    } catch (e) { $('deliveryError').textContent = e.message; }
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
