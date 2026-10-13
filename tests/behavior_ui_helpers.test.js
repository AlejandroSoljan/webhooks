// Asisto | Version: 5.00.291 | Fecha: 2026-10-13
const test = require('node:test');
const assert = require('node:assert/strict');
const { domainOptions } = require('../behavior_ui_helpers');
test('domain selector preserves current, deduplicates, sorts and escapes labels', () => {
  const html = domainOptions([{_id:'MSM'},{_id:'ALSO'},{_id:'MSM'},{_id:'<test>'}], 'MSM');
  assert.equal((html.match(/value="MSM"/g)||[]).length, 1);
  assert.match(html, /value="MSM" selected/);
  assert.ok(html.indexOf('ALSO') < html.indexOf('MSM'));
  assert.ok(html.includes('&lt;test&gt;'));
  assert.ok(!html.includes('<test>'));
  assert.equal(domainOptions([], 'MSM'), '<option value="MSM" selected>MSM</option>');
});
