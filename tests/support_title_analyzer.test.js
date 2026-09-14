// Asisto | Version: 5.00.083 | Fecha: 2026-09-09
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asistoTitleAnalyzer } = require('../src/support/title_analyzer');

test('overlong model output does not block subsequent task processing', async () => {
  const analyzer = asistoTitleAnalyzer({ OPENAI_API_KEY_TAREAS_WS: 'fixture-key' }, {
    runtimeFor: async () => ({}), configFor: async () => ({}),
    clientFor: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ subject: 'Configurar impresora '.repeat(8), description: 'Se requiere revisar la configuración. '.repeat(40) }) } }], usage: { total_tokens: 400 } }) } } }),
  });
  const result = await analyzer.run([{ text: 'Revisar impresora' }], { tenantId: 'ALSO' });
  assert.ok(result.subject.length <= 80);
  assert.ok(result.description.length <= 700);
  assert.equal(result.totalTokens, 400);
});

test('tenant AI returns a concise title and summary in one metered request', async () => {
  let request;
  const analyzer = asistoTitleAnalyzer({ OPENAI_API_KEY_TAREAS_WS: 'fixture-key' }, {
    runtimeFor: async () => ({ openaiApiKey: 'fixture-key' }),
    configFor: async () => ({ CHAT_MODEL: 'fixture-model' }),
    clientFor: () => ({ chat: { completions: { create: async input => {
      request = input;
      return { choices: [{ message: { content: JSON.stringify({ subject: 'Configurar impresora predeterminada', description: 'El cliente informó que la impresora no estaba configurada. Se indicó seleccionar la impresora correcta y confirmó que funcionó.' }) } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } };
    } } } }),
  });
  const result = await analyzer.run([{ fromMe:false, text:'No está configurada la impresora' }, { fromMe:true, text:'Probá seleccionando la impresora predeterminada' }, { fromMe:false, text:'Sí, genial' }], { tenantId:'ALSO' });
  assert.equal(request.model, 'fixture-model');
  assert.deepEqual(request.response_format, { type:'json_object' });
  assert.equal(result.subject, 'Configurar impresora predeterminada');
  assert.match(result.description, /confirmó que funcionó/);
  assert.equal(result.totalTokens, 50);
});
