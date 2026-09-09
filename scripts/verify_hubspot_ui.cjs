// Asisto | Version: 5.00.081 | Fecha: 2026-09-09
const { chromium } = require(process.env.ASISTO_PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless:true, ...(process.env.ASISTO_CHROME_PATH ? { executablePath:process.env.ASISTO_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setContent('<button id="add">Agregar tickets</button><script>add.onclick=()=>{const b=document.createElement("button");b.setAttribute("role","menuitem");b.textContent="Crear ticket";b.onclick=()=>{document.body.innerHTML=`<form id="ticket"><label>Nombre del ticket<input></label><label>Descripción del ticket<textarea></textarea></label>${[["Estado del ticket","En Proceso"],["Categoría","Soporte Remoto"],["Error tipo","Consulta / Capacitacion"],["Vía de contacto","WhatsApp"]].map(([l,v])=>`<label>${l}<button type="button" onclick="this.insertAdjacentHTML(\'afterend\',\'<button type=button role=option onclick=this.remove()>${v}</button>\')">Elegir</button></label>`).join("")}<button type="button" id="save">Crear</button></form>`;save.onclick=()=>{ticket.remove();document.body.insertAdjacentHTML("beforeend","<p>Ticket creado</p>")}};document.body.append(b)}</script>');
  await page.evaluate(() => { window.completed=[]; window.chrome={runtime:{sendMessage:async message=>{if(message.action==='HUBSPOT_UI_READY')return{data:{id:'d',fields:{subject:'Configurar impresora',description:'Configurar la impresora predeterminada',status:'En Proceso'}}};if(message.action==='HUBSPOT_UI_COMPLETE')completed.push(message);return{data:{}};}}}; });
  await page.addScriptTag({ path:path.join(__dirname,'../extensions/whatsapp-support/hubspot-ui.js') });
  await page.waitForTimeout(8000);
  if (!await page.evaluate(() => completed.length)) throw new Error(await page.locator('#asisto-hubspot-status').textContent() + '\n' + await page.locator('body').innerText());
  assert.equal(await page.locator('#asisto-hubspot-status').textContent(), 'Ticket guardado en HubSpot. La tarea fue cerrada en Asisto.');
  assert.equal(await page.locator('text=Ticket creado').count(), 1);
  console.log('PASS HubSpot Agregar tickets menu, automatic field completion and confirmed creation');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
