const test = require('node:test');
const assert = require('node:assert/strict');
const { qrPublicBranding } = require('../qr_product_web');

test('MCN scanner always uses Mecan identity while other tenants keep their configuration', () => {
  const configured = { pageTitle: 'Productos', pageSubtitle: 'Consultá', companyName: 'Otro', companyLogoUrl: 'https://example.com/logo.png', buttonColor: '#123456', buttonTextColor: '#abcdef' };
  assert.deepEqual(qrPublicBranding(configured, 'MCN'), {
    pageTitle: 'Productos', pageSubtitle: 'Consultá', companyName: 'Mecan',
    companyLogoUrl: '/customer-app/assets/mecan-logo.webp', buttonColor: '#e00000', buttonTextColor: '#ffffff',
  });
  assert.equal(qrPublicBranding(configured, 'OTRO').companyLogoUrl, configured.companyLogoUrl);
  assert.equal(qrPublicBranding(configured, 'OTRO').buttonColor, configured.buttonColor);
});
