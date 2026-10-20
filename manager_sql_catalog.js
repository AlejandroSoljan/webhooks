// Asisto | Manager Consulta_sql catalog adapter | 2026-10-20
function isManagerSql(value) {
  try { return /\/api\/Api_Consultas_Generales\/Consulta_sql\/?$/i.test(new URL(value).pathname); }
  catch { return false; }
}
function managerSqlUrl(value, type, query) {
  if (!['SKU', 'BARRA', 'ALTERNATIVOS'].includes(type)) throw new Error('invalid_catalog_type');
  const url = new URL(value);
  // The Manager filter grammar uses semicolons as separators; reject injection.
  const text = String(query || '').trim();
  if (!text || /[;\r\n\0]/.test(text)) throw Object.assign(new Error('invalid_catalog_query'), { statusCode: 400 });
  url.searchParams.delete('campo'); url.searchParams.delete('valor');
  url.searchParams.set('filtros', `tipo:${type};busqueda:${text}`);
  return url.toString();
}
function managerSqlRow(row) {
  const result = { ...row };
  // Preserve the configured price-list field, including additional lists.
  for (const [key, value] of Object.entries(row || {})) {
    const legacy = { codigo:'Codigo', codbarra:'Codbarra', descripcion:'Descripcion', stock:'Stock', desc_rubro:'Desc_Rubro', desc_subrubro:'Desc_Subrubro' }[key.toLowerCase()]
      || (/^precio_lp\d+$/i.test(key) ? key.replace(/^precio_lp/i, 'Precio_Lp') : null);
    if (legacy && !Object.hasOwn(result, legacy)) result[legacy] = value;
  }
  return result;
}
function managerSqlActionUrl(value, query) {
  let text = String(query || '').trim();
  let type = 'ALTERNATIVOS';
  if (/^%?codbarra:/i.test(text)) { type = 'BARRA'; text = text.replace(/^%?codbarra:/i, '').replace(/%/g, ''); }
  else if (/^sku:/i.test(text)) { type = 'SKU'; text = text.replace(/^sku:/i, ''); }
  else if (/^\d{8,14}$/.test(text)) type = 'BARRA';
  else if (/^[\w./-]*[./-][\w./-]+$/.test(text)) type = 'SKU';
  return managerSqlUrl(value, type, text.replace(/%+/g, ' ').trim());
}
function rankedManagerRows(rows) {
  return rows.filter(row => String(row.activo || 'S').toUpperCase() !== 'N')
    .sort((a,b) => Number(b.puntaje || 0) - Number(a.puntaje || 0));
}
module.exports = { isManagerSql, managerSqlUrl, managerSqlRow, rankedManagerRows, managerSqlActionUrl };
