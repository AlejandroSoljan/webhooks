// Asisto | Canonical público sin alterar URLs técnicas | 2026-10-27
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { JSDOM } = require('jsdom');
const { mountAuthRoutes, publicLandingPage } = require('../auth_ui');
const { publicSeoUrl } = require('../public_seo');
test('portada conserva formulario y declara Asisto en el dominio nuevo', () => {
  const doc = new JSDOM(publicLandingPage({ to:'/app', msg:'', error:'' })).window.document;
  assert.equal(doc.querySelector('link[rel=canonical]').href, 'https://asisto.com.ar/');
  assert.equal(doc.querySelector('meta[name="google-site-verification"]').content, 'G2MfNayP-53-_FRAnnBsjuPuudrOHs-jATJRpBOeBak');
  assert.equal(doc.querySelector('meta[property="og:url"]').content, 'https://asisto.com.ar/');
  assert.match(doc.title, /^Asisto \|/);
  assert.equal(doc.querySelector('meta[name=robots]').content, 'index,follow');
  assert.ok(doc.querySelector('form[action="/login"]'));
  assert.ok(doc.querySelector('input[type=password]'));
  const schemas = [...doc.querySelectorAll('script[type="application/ld+json"]')].map(x => JSON.parse(x.textContent));
  assert.ok(schemas.some(x => x['@type'] === 'WebSite' && x.name === 'Asisto' && x.url === publicSeoUrl('/')));
});
test('robots y sitemap prefieren dominio nuevo y excluyen pantallas privadas', async () => {
  const app = express(); mountAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const robots = await (await fetch(base + '/robots.txt')).text();
    assert.match(robots, /Sitemap: https:\/\/asisto\.com\.ar\/sitemap\.xml/);
    for (const area of ['/app','/ui/','/admin','/api/']) assert.ok(robots.includes('Disallow: ' + area));
    const sitemap = await (await fetch(base + '/sitemap.xml')).text();
    assert.match(sitemap, /<loc>https:\/\/asisto\.com\.ar\/<\/loc>/);
    assert.match(sitemap, /https:\/\/asisto\.com\.ar\/novedades/);
    assert.doesNotMatch(sitemap, /asistobot|\/admin|\/api\/|\/login/);
    const login = new JSDOM(await (await fetch(base + '/login')).text()).window.document;
    assert.equal(login.querySelector('link[rel=canonical]').href, publicSeoUrl('/'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
