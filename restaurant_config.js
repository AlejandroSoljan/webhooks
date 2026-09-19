// Asisto | Version: 5.00.169 | Fecha: 2026-09-19
const featureFields = {
  showImages:'restaurant_show_images', guestOrders:'restaurant_orders_enabled',
  guestAi:'restaurant_guest_ai_enabled', callWaiter:'restaurant_call_waiter_enabled',
  requestBill:'restaurant_request_bill_enabled', mercadoPago:'restaurant_mercadopago_enabled',
  guestNotifications:'restaurant_guest_notifications_enabled', orderTracking:'restaurant_order_tracking_enabled',
  operatorAi:'restaurant_operator_ai_enabled', kitchenBoard:'restaurant_kitchen_board_enabled',
  manualPayments:'restaurant_manual_payments_enabled', splitBill:'restaurant_split_bill_enabled',
};
const labels = ['Mostrar fotos de los platos','Pedidos desde el celular','IA del cliente','Llamar al mozo','Pedir la cuenta','Mercado Pago (botón informativo, todavía sin cobro)','Avisos a clientes con la carta abierta','Seguimiento y resumen de cuenta','IA del operario','Vista de cocina','Registro manual de pagos','Calculadora para dividir la cuenta'];
const fields = [
  { name:'restaurant_visit_code_required',value:true,help:'Solicitar código por visita para vincular celulares. true recomendado. Desactivarlo permite vincularse a una mesa abierta solo con su QR.' },
  { name:'restaurant_visit_hours',value:4,help:'Duración máxima de una visita QR desde su apertura, entre 1 y 24 horas. Cerrar la mesa revoca siempre todos los accesos.' },
  { name:'restaurant_order_confirmation_required',value:true,help:'Los pedidos del celular requieren confirmación del operador antes de aparecer en cocina. Por defecto true.' },
  { name:'restaurant_enabled', value:false, help:'Habilita el módulo Restaurante para este dominio. Ausente: deshabilitado.' },
  ...Object.entries(featureFields).map(([feature,name],index)=>({ name,feature,value:true,help:labels[index]+'. Valores: true / false. Por defecto: true.' })),
  { name:'restaurant_display_name', value:'',help:'Nombre visible en la carta. Vacío: nombre de la empresa.' },
  { name:'restaurant_tagline', value:'Cocina de encuentro',help:'Frase breve debajo del nombre de la carta.' },
  { name:'restaurant_logo_url', value:'',help:'Logo de este restaurante: URL HTTPS pública o ruta /static/. Vacío: logo de ejemplo.' },
  { name:'restaurant_ai_model', value:'gpt-4o-mini',help:'Modelo de IA para consultas de carta y asistencia al operario.' },
];
function settings(config = {}) {
  return Object.fromEntries(Object.entries(featureFields).map(([feature,name])=>[feature, typeof config[name] === 'boolean' ? config[name] : feature === 'guestOrders' ? true : config.restaurant_features?.[feature] !== false]));
}
function validateRestaurantConfig(data) {
  if(Object.hasOwn(data,'restaurant_visit_hours') && (!Number.isInteger(data.restaurant_visit_hours) || data.restaurant_visit_hours<1 || data.restaurant_visit_hours>24)) throw Error('restaurant_visit_hours: usá un entero entre 1 y 24.');
  for (const field of fields) {
    if (!Object.hasOwn(data,field.name)) continue;
    if (typeof field.value === 'boolean' && typeof data[field.name] !== 'boolean') throw Error(field.name+': usá true o false.');
    if (typeof field.value === 'string' && typeof data[field.name] !== 'string') throw Error(field.name+': usá un texto.');
  }
  if (Object.hasOwn(data,'restaurant_logo_url')) {
    const logo=data.restaurant_logo_url.trim();
    if (logo.length>1000 || (logo && !/^https:\/\/[^\s<>"']+$/i.test(logo) && !/^\/static\/[a-z0-9_./-]+$/i.test(logo))) throw Error('restaurant_logo_url: ingresá una URL HTTPS o una ruta /static/.');
    data.restaurant_logo_url=logo;
  }
}
module.exports={featureFields,fields,settings,validateRestaurantConfig};
