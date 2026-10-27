// Asisto | Dominio público canónico para buscadores, no para integraciones | 2026-10-27
'use strict';
const PUBLIC_SEO_ORIGIN = 'https://asisto.com.ar';
function publicSeoUrl(path = '/') { return new URL(path, PUBLIC_SEO_ORIGIN).href; }
module.exports = { PUBLIC_SEO_ORIGIN, publicSeoUrl };
