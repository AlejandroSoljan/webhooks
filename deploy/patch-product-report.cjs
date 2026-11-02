const fs=require('fs'),path=require('path');const [target,source]=process.argv.slice(2);
const read=n=>fs.readFileSync(path.join(target,n),'utf8'),write=(n,s)=>{const p=path.join(target,n);if(fs.existsSync(p))fs.unlinkSync(p);fs.writeFileSync(p,s)};
for(const n of ['product_insights.js','product_insights_panel.js'])write(n,fs.readFileSync(path.join(source,n),'utf8'));
write('HISTORIAL_CAMBIOS_BACKEND.txt',"2026-11-02 | v5.00.331 | Productos: total unico y desglose por origen/resultado; historico separado; sin cambios de datos ni facturacion. Tests product_insights.\n"+read('HISTORIAL_CAMBIOS_BACKEND.txt'));
const v=JSON.parse(read('ASISTO_VERSION.json'));Object.assign(v,{version:'5.00.331',fecha:'2026-11-02',date:'2026-11-02'});write('ASISTO_VERSION.json',JSON.stringify(v,null,2)+'\n');
