// Asisto | Minimal dedicated-service integration, retaining installed queue fixes | 2026-10-16
const fs=require('fs'),assert=require('node:assert/strict');
const file=process.argv[2];assert.ok(file?.endsWith('/turnero_server.js'));
let source=fs.readFileSync(file,'utf8');
assert.ok(!source.includes('mountQueueScannerRedirect'),'Scanner already integrated');
const anchors=["const { mountCustomerApp } = require('./customer_app_web');","app.use(auth.attachUser);"];
for(const a of anchors)assert.equal(source.split(a).length,2,'Integration anchor changed');
const hadExpiry=source.includes('expirePreviousDays');
source=source.replace(anchors[0],anchors[0]+"\nconst { mountQueueScannerRedirect } = require('./qr_local_scanner');");
source=source.replace(anchors[1],anchors[1]+'\nmountQueueScannerRedirect(app);');
assert.equal(source.includes('expirePreviousDays'),hadExpiry);
fs.writeFileSync(file,source);
const root=require('node:path').dirname(file),release=JSON.parse(fs.readFileSync(root+'/SCANNER_RELEASE.json','utf8'));
const log=root+'/HISTORIAL_CAMBIOS_BACKEND.txt';
const previous=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
if(!previous.includes(release.changelog))fs.writeFileSync(log,release.changelog+'\n\n'+previous);
console.log('DEDICATED_SCANNER_INTEGRATED');
