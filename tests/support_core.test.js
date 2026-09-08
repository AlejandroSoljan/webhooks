// Asisto | Version: 5.00.066 | Fecha: 2026-09-08
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVault, vaultFromEnv } = require('../src/support/crypto');
const { scopeOf, settings, excluded, groupMessages, analyze, range, scopedId } = require('../src/support/core');
const { HubSpotContract } = require('../src/support/hubspot');
const { localTranscriber } = require('../src/support/baileys');
const { Readable } = require('node:stream');
const { inspectConfiguration } = require('../src/support/config');

test('vault binds ciphertext to owner and purpose and supports key rotation', () => {
  const old = Buffer.alloc(32, 1).toString('base64'), next = Buffer.alloc(32, 2).toString('base64');
  const vault = createVault({ old }, 'old'), aad = scopedId({ tenantId: 'a', userId: '1' }, 'auth');
  const sealed = vault.seal({ secret: 'sample-only' }, aad);
  assert.equal(JSON.stringify(sealed).includes('sample-only'), false);
  assert.deepEqual(createVault({ old, next }, 'next').open(sealed, aad), { secret: 'sample-only' });
  assert.throws(() => vault.open(sealed, scopedId({ tenantId: 'b', userId: '1' }, 'auth')));
  assert.throws(() => vault.open({ ...sealed, tag: Buffer.alloc(16).toString('base64') }, aad));
  assert.throws(() => createVault({ old: 'short' }, 'old'));
});
test('setup diagnostics fail closed and do not expose secrets', () => {
  const { ready, checks } = inspectConfiguration({ SUPPORT_ENABLED: 'true', SUPPORT_PUBLIC_ORIGIN: 'http://public.example', SUPPORT_ENCRYPTION_KEYS: 'secret-invalid-json', AUTH_COOKIE_SECRET: 'short' });
  assert.equal(ready, false); assert.equal(checks.find(c => c.key === 'origin').ok, false);
  assert.equal(JSON.stringify(checks).includes('secret-invalid-json'), false);
});

test('existing Asisto variables configure web and worker encryption consistently', () => {
  const env = { SUPPORT_ENABLED: 'true', PUBLIC_BASE_URL: 'https://asisto.example/app', AUTH_COOKIE_SECRET: 'fixture-only-existing-cookie-secret-123456', MONGODB_URI: 'mongodb://fixture' };
  const web = inspectConfiguration(env), worker = vaultFromEnv({ ...env });
  assert.equal(web.ready, true);
  assert.equal(web.publicOrigin, 'https://asisto.example');
  const sealed = web.vault.seal({ text: 'private' }, 'owner');
  assert.deepEqual(worker.open(sealed, 'owner'), { text: 'private' });
  assert.throws(() => worker.open(sealed, 'other-owner'));
  assert.throws(() => vaultFromEnv({ ...env, AUTH_COOKIE_SECRET: 'different-fixture-cookie-secret-123456' }).open(sealed, 'owner'));
  // The existing cookie secret is input to a domain-separated derivation,
  // not used directly as the AES key.
  const raw = createVault({ [sealed.kid]: Buffer.from(env.AUTH_COOKIE_SECRET).subarray(0, 32).toString('base64') }, sealed.kid);
  assert.throws(() => raw.open(sealed, 'owner'));
});

test('derived encryption rejects missing and unsafe existing secrets', () => {
  for (const AUTH_COOKIE_SECRET of [undefined, '', 'short', 'dev-unsafe-secret-change-me']) {
    assert.throws(() => vaultFromEnv({ AUTH_COOKIE_SECRET }), /support_secure_cookie_secret_required/);
  }
});

test('legacy Asisto login can reuse a strong existing API secret for encryption', () => {
  const env = { SUPPORT_ENABLED: 'true', PUBLIC_BASE_URL: 'https://asisto.example', MONGODB_URI: 'mongodb://fixture', AUTH_COOKIE_SECRET: 'legacy-login', WWEB_API_KEY: 'legacy-wweb', OPENAI_API_KEY: 'fixture-only-api-key-with-at-least-32-characters' };
  const config = inspectConfiguration(env);
  assert.equal(config.ready, true);
  const sealed = config.vault.seal({ preserved: true }, 'owner');
  assert.equal(sealed.kid, 'asisto-openai-v1');
  assert.deepEqual(vaultFromEnv(env).open(sealed, 'owner'), { preserved: true });
  // Adding a suitable preferred source retains decryption by the old source ID.
  const next = vaultFromEnv({ ...env, WWEB_API_KEY: 'fixture-only-strong-whatsapp-key-1234567890' });
  assert.deepEqual(next.open(sealed, 'owner'), { preserved: true });
  assert.equal(next.seal({}, 'owner').kid, 'asisto-wweb-v1');
  assert.equal(inspectConfiguration({ ...env, AUTH_COOKIE_SECRET: 'dev-unsafe-secret-change-me' }).ready, false);
  assert.equal(inspectConfiguration({ ...env, OPENAI_API_KEY: 'short' }).ready, false);
  assert.throws(() => vaultFromEnv({ ...env, OPENAI_API_KEY: 'different-fixture-api-key-with-at-least-32-characters' }).open(sealed, 'owner'));
});

test('existing explicit keyrings and origin overrides retain priority without silent fallback', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const env = { AUTH_COOKIE_SECRET: 'fixture-only-existing-cookie-secret-123456', PUBLIC_BASE_URL: 'https://asisto.example', SUPPORT_PUBLIC_ORIGIN: 'https://override.example', SUPPORT_ENCRYPTION_KEYS: JSON.stringify({ v1: key }), SUPPORT_ACTIVE_KEY: 'v1' };
  const sealed = createVault({ v1: key }, 'v1').seal({ kept: true }, 'owner');
  assert.deepEqual(vaultFromEnv(env).open(sealed, 'owner'), { kept: true });
  assert.equal(inspectConfiguration(env).publicOrigin, 'https://override.example');
  for (const overrides of [{ SUPPORT_ENCRYPTION_KEYS: 'invalid' }, { SUPPORT_ENCRYPTION_KEYS: undefined }, { SUPPORT_ACTIVE_KEY: undefined }, { SUPPORT_ENCRYPTION_KEYS: '' }]) {
    assert.throws(() => vaultFromEnv({ ...env, ...overrides }));
  }
  assert.equal(inspectConfiguration({ ...env, SUPPORT_PUBLIC_ORIGIN: 'http://unsafe.example' }).publicOrigin, undefined);
});
test('scope cannot fall back to a global tenant and respects page access', () => {
  assert.throws(() => scopeOf({ uid: '1', role: 'user' }), /authentication_required/);
  assert.throws(() => scopeOf({ uid: '1', tenantId: 'a', role: 'user', allowedPages: [] }), /forbidden/);
  assert.deepEqual(scopeOf({ uid: '1', tenantId: 'a', role: 'user', allowedPages: ['support'] }), { userId: '1', tenantId: 'a' });
  assert.throws(() => settings({ mode: 'automatic' }), /automation_not_enabled/);
  assert.throws(() => range('2026-01-01', '2026-03-01'), /invalid_range/);
});
test('exclusions are configurable and groups/broadcasts never enter', () => {
  const config = settings({ excludedNames: ['Juan Garziera'], excludedJids: ['1@s.whatsapp.net'] });
  assert.ok(excluded({ jid: 'x@g.us' }, config));
  assert.ok(excluded({ jid: 'status@broadcast' }, config));
  assert.ok(excluded({ jid: 'x@lid', name: 'JUAN GARZIERA' }, config));
  assert.ok(excluded({ jid: '1@s.whatsapp.net' }, config));
  assert.equal(excluded({ jid: '2@s.whatsapp.net', name: 'Esther' }, config), false);
});
test('inactivity groups ordered full exchanges including outgoing messages', () => {
  const at = ms => new Date(ms), messages = [
    { _id: '3', at: at(180001), text: 'social', fromMe: false },
    { _id: '1', at: at(0), text: 'Manager no imprime', fromMe: false },
    { _id: '2', at: at(1), text: 'Revisamos el error', fromMe: true },
  ];
  assert.equal(groupMessages(messages, 180000).length, 1);
  const groups = groupMessages(messages, 179999);
  assert.equal(groups.length, 2);
  assert.match(analyze(groups[0]).description, /Operador: Revisamos/);
  assert.equal(analyze(groups[0]).channel, 'WhatsApp');
  assert.equal(analyze(groups[1]).result, 'draft');
  assert.equal(analyze([{ _id: 'x', at: at(0), text: 'Manager error', fromMe: true }]).result, 'draft');
});
test('HubSpot fetch paginates, pins origin and never exposes server error details', async () => {
  const calls = [];
  const client = new HubSpotContract('fake-token', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ results: [{ id: String(calls.length) }], ...(calls.length === 1 ? { paging: { next: { after: '1' } } } : {}) }) };
  });
  assert.equal((await client.companyTickets('123')).length, 2);
  assert.ok(calls.every(c => c.url.startsWith('https://api.hubapi.com/') && c.options.redirect === 'error'));
  assert.equal(JSON.parse(calls[1].options.body).after, '1');
  const failed = new HubSpotContract('secret', async () => ({ ok: false, status: 429 }));
  await assert.rejects(() => failed.metadata(), /hubspot_rate_limited/);
});
test('HubSpot payload uses discovered internal IDs and writable dates only', () => {
  const metadata = { properties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'createdate', 'closed_date'].map(name => ({ name, modificationMetadata: { readOnlyValue: name === 'createdate' } })), pipelines: [{ id: 'p', stages: [{ id: 'new', metadata: { isClosed: 'false' } }, { id: 'done', metadata: { isClosed: 'true' } }] }], associationTypes: { companies: [{ typeId: 123, category: 'HUBSPOT_DEFINED', label: null }], contacts: [] } };
  const client = new HubSpotContract('fake'), fields = { subject: 'Manager', description: 'Detalle', messageDate: '2026-01-01T00:00:00Z', closedDate: '2026-01-02T00:00:00Z', companyId: '1' };
  const open = client.prepare(fields, metadata, { pipelineId: 'p', stageId: 'new' });
  assert.equal(open.properties.createdate, undefined); assert.equal(open.properties.closed_date, undefined);
  assert.equal(open.associations[0].types[0].associationTypeId, 123);
  assert.equal(client.prepare(fields, metadata, { pipelineId: 'p', stageId: 'done' }).properties.closed_date, fields.closedDate);
  assert.throws(() => client.prepare(fields, metadata, { pipelineId: 'p', stageId: 'Nuevo' }), /invalid_pipeline_stage/);
});
test('local audio gateway receives bounded bytes and download uses abort signal without sender URL', async () => {
  let downloads = 0;
  const gateway = localTranscriber({ SUPPORT_TRANSCRIBER_URL: 'http://127.0.0.1:8090/transcribe', SUPPORT_TRANSCRIBER_MODEL: 'fixture' }, {
    loadBaileys: async () => ({ BufferJSON: {}, normalizeMessageContent: m => m, downloadContentFromMessage: async (message, type, options) => {
      downloads++;
      assert.equal(message.url, undefined); assert.equal(message.directPath, '/fixture');
      assert.equal(type, 'audio'); assert.ok(options.options.signal instanceof AbortSignal); assert.equal(options.options.redirect, 'error');
      return Readable.from([Buffer.from('audio')]);
    } }),
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, 'http://127.0.0.1:8090'); assert.equal(options.body.toString(), 'audio'); assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ text: 'Manager falla' }) };
    },
  });
  const raw = JSON.stringify({ message: { audioMessage: { directPath: '/fixture', url: 'http://untrusted.example/audio' } } });
  assert.deepEqual(await gateway.run(raw, { seconds: 5, bytes: 5, mimetype: 'audio/ogg' }), { text: 'Manager falla', costUsd: 0 });
  await assert.rejects(() => gateway.run(raw, { seconds: 601, bytes: 5 }), /audio_limit_exceeded/);
  assert.equal(downloads, 1);
});
test('installed Baileys decrypts audio from directPath without requiring the removed URL field', async () => {
  const b = await import('@whiskeysockets/baileys');
  const { createCipheriv } = require('node:crypto');
  const { downloadAudio } = require('../src/support/baileys');
  const key = Buffer.alloc(32, 8), keys = await b.getMediaKeys(key, 'audio');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const encrypted = Buffer.concat([cipher.update('fixture audio bytes'), cipher.final(), Buffer.alloc(10)]);
  const originalFetch = global.fetch;
  global.fetch = async url => { assert.equal(url, 'https://mmg.whatsapp.net/fixture'); return { ok: true, body: Readable.from([encrypted]) }; };
  try {
    const raw = JSON.stringify({ message: { audioMessage: { directPath: '/fixture', mediaKey: key, url: 'https://sender.invalid/unused' } } }, b.BufferJSON.replacer);
    const bytes = await downloadAudio(raw, { seconds: 5, bytes: 50 });
    assert.equal(bytes.toString(), 'fixture audio bytes');
  } finally { global.fetch = originalFetch; }
});
test('accounting guidance is a documentable task without a literal Manager mention', () => {
  const rows = [
    { _id: 'request', at: new Date('2026-09-08T14:19:14Z'), fromMe: false, text: 'Necesitaría tener un totalizador por cuenta entre fechas. Por ejemplo, todo agosto, cuánto asignamos a cada cuenta para la definición del gasto.' },
    { _id: 'reply', at: new Date('2026-09-08T14:20:57Z'), fromMe: true, text: 'Tenés que ir al módulo de contabilidad y sacar sumas y saldos por niveles. Previamente tenés que hacer la interfaz contable para pasar los movimientos. Ahora te paso un videíto del proceso.' },
    { _id: 'thanks', at: new Date('2026-09-08T14:22:00Z'), fromMe: false, text: 'Dale, perfecto. Genial.' },
  ];
  const result = analyze(rows);
  assert.equal(result.result, 'draft');
  assert.equal(result.subject, 'Totalizador de gastos por cuenta y período');
  assert.equal(result.errorType, 'Consulta / Capacitacion');
  assert.equal(result.status, 'En Proceso');
  assert.match(result.description, /interfaz contable/);
  assert.match(result.description, /envío y la resolución deben confirmarse/);
  assert.match(result.description, /Conversación de origen/);
});

test('non-excluded conversations are documented without a keyword or speaker gate', () => {
  const incoming = text => ({ _id: 'in', at: new Date(), fromMe: false, text });
  const outgoing = text => ({ _id: 'out', at: new Date(), fromMe: true, text });
  assert.equal(analyze([incoming('Hola, buen día'), outgoing('Tenés que ir a contabilidad')]).result, 'draft');
  assert.equal(analyze([incoming('Necesito organizar el cumpleaños'), outgoing('Yo trabajo con un sistema contable')]).result, 'draft');
  assert.equal(analyze([outgoing('Necesitás configurar Manager')]).result, 'draft');
  assert.equal(analyze([incoming('Necesito un reporte de stock por depósito')]).result, 'draft');
});
test('task categories use the existing HubSpot taxonomy', () => {
  for (const [text, expected] of [
    ['Necesito revisar el servidor virtual', 'Soporte Servidor Virtual'],
    ['Coordinamos una visita técnica presencial', 'Soporte en Lugar'],
    ['Necesito desarrollar un nuevo módulo', 'Desarrollo'],
    ['Hagamos el relevamiento para la implementación', 'Analisis e Implementacion'],
    ['Coordinemos una reunión por el proyecto', 'Reunion Cliente'],
    ['Necesito renovar la licencia', 'Soporte Administrativo'],
    ['La impresora tiene un problema', 'Soporte Hardware'],
    ['Necesito un listado con los datos', 'Solicitud de Datos'],
    ['Consulta por preinstall', 'Soporte Preinstall'],
    ['Revisamos los reportes de contabilidad', 'Soporte Remoto'],
  ]) assert.equal(analyze([{ _id: 'case', at: new Date(), fromMe: false, text }]).category, expected);
});
