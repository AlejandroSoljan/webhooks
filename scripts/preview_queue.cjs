// Asisto | Vista local con datos ficticios; no usa Mongo ni Firebase | 2026-09-14
const express = require('express'), QRCode = require('qrcode');
const { queuePage } = require('../queue_pages');
const app = express(); app.use(express.json());
app.use('/customer-app/assets', express.static(require('path').join(__dirname, '../static/turnero')));
const sectors = [{ id: 'ferreteria', name: 'Ferretería' }, { id: 'herrajes', name: 'Herrajes' }, { id: 'buloneria', name: 'Bulonería' }, { id: 'caja', name: 'Caja' }, { id: 'retiro', name: 'Retiro de pedidos' }];
app.get('/preview/:mode', (q, r) => r.send(queuePage('DEMO_FERRETERIA', q.params.mode).replace('<main>', '<main><p style="background:#fff3cc;padding:12px">VISTA PREVIA LOCAL · QR ficticio, no usar desde el celular.</p>')));
app.get('/api/customer-app/DEMO_FERRETERIA/config', (q, r) => r.json({ businessName: 'Mecan', queuePresence: 'open', queuePromotion: '', sectors }));
let printed = false;
app.post('/api/customer-app/DEMO_FERRETERIA/tickets', async (q, r) => { printed = false; r.json({ id: 'preview', displayNumber: 'F042', sectorName: sectors.find(s => s.id === q.body.sectorId)?.name, status: 'RESERVED', claimQr: await QRCode.toDataURL('http://127.0.0.1:3188/preview/claim-demo'), reservationExpiresAt: new Date(Date.now() + 180000) }); });
app.get('/api/customer-app-admin/DEMO_FERRETERIA/tickets/preview/delivery', (q, r) => r.json({ status: printed ? 'WAITING' : 'RESERVED', claimed: false, deliveryMode: printed ? 'print' : 'pending' }));
app.post('/api/customer-app-admin/DEMO_FERRETERIA/tickets/preview/print', (q, r) => { printed = true; r.json({ displayNumber: 'F042', sectorName: 'Ferretería', businessName: 'Mecan', createdAt: new Date() }); });
app.get('/api/customer-app/DEMO_FERRETERIA/queue', (q, r) => r.json({ sectors: [{ id: 'ferreteria', name: 'Ferretería', current: { id: 'demo', displayNumber: 'F023', desk: 'Mostrador 1' }, waiting: 3, next: [{ displayNumber: 'F024' }, { displayNumber: 'F025' }] }, { id: 'caja', name: 'Caja', current: null, waiting: 0, next: [] }] }));
app.listen(3188, '127.0.0.1', () => console.log('Preview http://127.0.0.1:3188/preview/kiosk'));
