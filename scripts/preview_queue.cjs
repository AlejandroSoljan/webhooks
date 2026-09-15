// Asisto | Vista local con datos ficticios, sin acceso a MongoDB | Fecha: 2026-09-14
const express=require('express'),QRCode=require('qrcode'),{queuePage}=require('../queue_pages');
const app=express();app.get('/preview/:mode',(q,r)=>r.send(queuePage('DEMO_FERRETERIA',q.params.mode)));
app.get('/api/customer-app/DEMO_FERRETERIA/config',(q,r)=>r.json({businessName:'Mecan',queuePresence:'open',queuePromotion:'',sectors:[{id:'ferreteria',name:'Ferretería'},{id:'herrajes',name:'Herrajes'},{id:'buloneria',name:'Bulonería'},{id:'caja',name:'Caja'},{id:'retiro',name:'Retiro de pedidos'}]}));
app.get('/api/customer-app-admin/DEMO_FERRETERIA/presence',async(q,r)=>r.json({image:await QRCode.toDataURL('https://asistobot.com.ar/customer-app/DEMO_FERRETERIA?view=turns')}));
app.get('/api/customer-app/DEMO_FERRETERIA/queue',(q,r)=>r.json({sectors:[{id:'ferreteria',name:'Ferretería',current:{id:'demo',displayNumber:'F023',desk:'Mostrador 1'},waiting:3,next:[{displayNumber:'F024'},{displayNumber:'F025'}]},{id:'caja',name:'Caja',current:null,waiting:0,next:[]}]}));
app.listen(3188,'127.0.0.1',()=>console.log('Preview http://127.0.0.1:3188/preview/kiosk'));
