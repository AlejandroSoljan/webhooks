// Regenera inventarios documentales; no accede a configuración ni bases de datos.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs/manual-tecnico');
const files = cp.execFileSync('git', ['ls-files', '*.js', '*.cjs'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(f => !/^(tests|scripts|static|extensions|android-scanner)\//.test(f));
const esc = s => String(s).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
const ref = (f, line) => `[${f}:${line}](../../${f}#L${line})`;
const routes = [], env = new Map(), collections = new Map();
function add(map, key, where) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(where); }
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  const line = i => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete|all|use)\(\s*(['"])(\/[^'"\r\n]*)\2/g)) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 130).split(/\r?\n/)[0];
    routes.push(`| ${m[1].toUpperCase()} | \`${esc(m[3])}\` | ${ref(f,line(m.index))} | \`${esc(tail).replace(/`/g,'').slice(0,110)}\` |`);
  }
  for (const m of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) add(env, m[1], ref(f,line(m.index)));
  // Dependency-injected environment objects retain explicit variable names.
  if (/\benv\s*=\s*process\.env\b/.test(text)) {
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) add(env, m[1], ref(f,line(m.index)));
  }
  for (const m of text.matchAll(/\.collection\(\s*['"]([^'"]+)['"]\s*\)/g)) add(collections,m[1],ref(f,line(m.index)));
}
fs.mkdirSync(out,{recursive:true});
const banner = '# Inventario generado desde el código\n\nRegenerar: `node scripts/build_technical_manual.cjs`. No contiene valores de producción.\n\n';
fs.writeFileSync(path.join(out,'rutas.md'),banner+'## Rutas HTTP detectadas\n\nEste índice estático no es un contrato OpenAPI: incluye rutas internas, posibles registros no montados y prefijos parciales. La columna final es un fragmento literal posterior a la ruta, no una certificación de autenticación. Verificar el montaje y el handler enlazado antes de integrar. No detecta todas las rutas construidas dinámicamente ni arrays de aliases.\n\n| Método | Ruta declarada | Implementación | Inicio de registro / middleware |\n|---|---|---|---|\n'+routes.sort().join('\n')+'\n');
for(const [name,map,title] of [['entorno',env,'Variable'],['colecciones',collections,'Colección']])fs.writeFileSync(path.join(out,name+'.md'),banner+`## ${title}s detectadas\n\nReferencias estáticas; que un nombre exista no significa que sea obligatorio o esté activo. Las variables indirectas, calculadas o seleccionadas mediante mapas requieren revisar su módulo.\n\n| ${title} | Referencias |\n|---|---|\n`+[...map].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`| \`${esc(k)}\` | ${[...v].join('; ')} |`).join('\n')+'\n');
const ui=fs.readFileSync(path.join(root,'auth_ui.js'),'utf8');
const block=ui.slice(ui.indexOf('const fieldHelp = {'),ui.indexOf('function fieldHelpDescription'));
const help=[...block.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)].map(m=>[m[1],m[2]]);
const restaurant=require('../restaurant_config');
for(const f of restaurant.fields)help.push([f.name,f.help]);
fs.writeFileSync(path.join(out,'variables-dominio.md'),banner+'## Variables de dominio con descripción del panel\n\nSe guardan en `tenant_config`, salvo indicación del módulo. Descripciones tomadas de la ayuda existente; no implican valores productivos. Los secretos se configuran por el canal seguro correspondiente. JSON usa booleanos `true`/`false`, números sin comillas y listas reales.\n\n| Campo | Función / reglas |\n|---|---|\n'+help.sort(([a],[b])=>a.localeCompare(b)).map(([a,b])=>`| \`${a}\` | ${esc(b)} |`).join('\n')+'\n\n`consumption_domains`: lista de dominios cuyos consumos se consolidan bajo este titular. Es independiente de permisos, canales y aliases de integración.\n\n`token_cost_*_per_1k`: costo configurado por 1.000 tokens. `token_charge_*_per_1k`: tarifa legacy de cobro. Revisar precedencias de monetización en el manual principal.\n');
console.log(JSON.stringify({routes:routes.length,environment:env.size,collections:collections.size,domainFields:help.length}));
