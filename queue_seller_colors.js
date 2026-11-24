// Asisto | Seller identity colors, staged for maintenance deployment | 2026-11-12
function normalizeColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : ''; }
function savedColor(item, previous) {
  if (item.color === undefined) return normalizeColor(previous?.color);
  if (item.color === '' || item.color === null) return '';
  const color = normalizeColor(item.color);
  if (!color) { const error = new Error('Elegí un color válido para el vendedor.'); error.status = 400; throw error; }
  return color;
}
function createSellerColorPicker(item, row) {
  const box=document.createElement('div');box.className='sellerColorPicker';box.setAttribute('role','group');box.setAttribute('aria-label','Color de identificación');
  row.dataset.color=/^#[0-9a-f]{6}$/i.test(item.color||'')?item.color.toUpperCase():'';
  const choices=[['','Sin color'],['#A16207','Ocre'],['#EA580C','Naranja'],['#0D9488','Verde agua'],['#9333EA','Violeta'],['#4D7C0F','Verde oliva'],['#0891B2','Celeste'],['#2563EB','Azul'],['#DB2777','Rosa'],['#00FF00','Verde eléctrico'],['#EEDD00','Amarillo'],['#FFCCFF','Lila claro'],['#553366','Ciruela'],['#00EE99','Menta'],['#DDDDAA','Arena'],['#FF88FF','Orquídea'],['#AA6666','Terracota'],['#334422','Verde bosque'],['#88DD44','Lima'],['#880011','Bordó'],['#880088','Púrpura'],['#7799EE','Lavanda azul'],['#FF0044','Rojo frambuesa'],['#FF00EE','Fucsia'],['#00EEFF','Cian'],['#0000FF','Azul eléctrico'],['#FFAA11','Ámbar']];
  if(row.dataset.color&&!choices.some(x=>x[0]===row.dataset.color))choices.push([row.dataset.color,'Color actual']);
  const label=document.createElement('small');label.textContent='Color de identificación';box.append(label);
  for(const [color,name] of choices){const b=document.createElement('button');b.type='button';b.className='sellerColorSwatch';b.title=name;b.setAttribute('aria-label',name);b.dataset.color=color;b.style.setProperty('--swatch',color||'#64748B');const rgb=(color||'#64748B').slice(1).match(/../g).map(x=>{const c=parseInt(x,16)/255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4)});b.style.color=rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722>0.179?'#000000':'#FFFFFF';b.onclick=()=>{row.dataset.color=color;refresh()};box.append(b)}
  function refresh(){for(const b of box.querySelectorAll('button')){const selected=b.dataset.color===row.dataset.color;b.setAttribute('aria-pressed',String(selected));b.textContent=selected?'✓':(b.dataset.color?'':'—')}}refresh();return box;
}
function applySellerColor(card, header, ticket, sellers) {
  const current=(sellers||[]).find(s=>s.id===ticket.sellerId);
  const color=/^#[0-9a-f]{6}$/i.test(current?.color||'')?current.color:'#64748B';
  card.classList.add('sellerColoredTicket');card.style.setProperty('--seller-color',color);card.style.setProperty('--seller-tint',color+'20');
  header.classList.add('sellerColorHeader');card.prepend(header);
  const eyebrow=card.querySelector('.multiEyebrow');if(eyebrow)eyebrow.remove();
}
function applyClosedSellerColor(tile, label, ticket, sellers) {
  const seller=(sellers||[]).find(s=>s.id===ticket.sellerId);
  const color=/^#[0-9a-f]{6}$/i.test(seller?.color||'')?seller.color:'#64748B';
  tile.classList.add('sellerColoredClosed');tile.style.setProperty('--seller-color',color);tile.style.setProperty('--seller-tint',color+'14');
  const name=document.createElement('small');name.className='closedSellerName';name.textContent=ticket.sellerName||seller?.name||'Sin vendedor';name.title=name.textContent;label.append(name);
}
const css=`
.admin .recoveryTile.sellerColoredClosed{border-left:4px solid var(--seller-color);background:var(--seller-tint)}
.admin .sellerColoredClosed .closedSellerName{display:block;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:750;color:#475569;margin-top:3px}
.admin[data-theme="dark"] .sellerColoredClosed .closedSellerName{color:#e2e8f0}
.sellerRow{grid-template-columns:minmax(150px,1fr) minmax(230px,auto) auto}
.sellerColorPicker{display:flex;gap:7px;flex-wrap:wrap;align-items:center;max-width:310px}.sellerColorPicker small{flex-basis:100%;font-size:12px;font-weight:700}
.sellerRow .sellerColorSwatch{width:28px;height:28px;min-height:28px;padding:0;border-radius:50%;background:var(--swatch);color:white;border:2px solid transparent;font-size:18px;line-height:24px}
.sellerColorSwatch[aria-pressed="true"]{outline:2px solid #14243a;outline-offset:2px}.sellerColorSwatch:focus-visible{outline:3px solid #14243a;outline-offset:3px}
.admin .multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}
.admin .multiTicket.sellerColoredTicket{border-left:7px solid var(--seller-color);display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,1fr);gap:3px 12px;align-content:start;align-items:start;padding:14px;min-height:0}
.admin .sellerColoredTicket .sellerColorHeader{grid-column:1/-1;width:100%;margin:0 0 10px;padding:10px 12px;border-radius:8px;background:var(--seller-tint)}
.admin .sellerColorHeader .sellerNameLine{color:#14243a!important;font-size:18px!important;font-weight:850}.admin .sellerColorHeader .uiIcon{color:var(--seller-color)}
.admin .sellerColoredTicket .multiNumber{grid-column:1;grid-row:2;font-size:54px;margin:0;line-height:1.1}.admin .sellerColoredTicket .multiDesk{grid-column:1;grid-row:3;font-size:15px}.admin .sellerColoredTicket .multiTimer{grid-column:1;grid-row:4;font-size:13px;margin:6px 0 0}
.admin .sellerColoredTicket .multiActions{grid-column:2;grid-row:2/5;grid-template-columns:repeat(2,minmax(0,1fr));width:100%;margin:0;align-self:center}.admin .sellerColoredTicket .multiActions button{min-height:40px;font-size:12px}
.admin[data-theme="dark"] .sellerColoredTicket{border-left-color:var(--seller-color)}.admin[data-theme="dark"] .sellerColorHeader{background:#f1f5f9}
@media(max-width:1100px){.admin .multiTicket.sellerColoredTicket{display:flex;flex-direction:column;align-items:stretch}.admin .sellerColoredTicket .multiActions{margin-top:12px}.sellerRow{grid-template-columns:1fr auto}.sellerColorPicker{grid-column:1/-1;grid-row:2}}
@media(max-width:600px){.admin .multiTickets{grid-template-columns:1fr}}
`;
module.exports={normalizeColor,savedColor,createSellerColorPicker,applySellerColor,applyClosedSellerColor,css};
