// Asisto | Version: 5.00.264 | Fecha: 2026-09-28
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asistoTitleAnalyzer, resolveTasksModel } = require('../src/support/title_analyzer');

test('ALSO, DEMJG and SANA migrate the former tasks model without replacing another explicit override', () => {
  for (const tenantId of ['ALSO', 'demjg', 'SANA']) {
    assert.equal(resolveTasksModel({ openai: { tasks_model: 'gpt-5.4-mini' } }, {}, tenantId), 'gpt-4o-mini');
  }
  assert.equal(resolveTasksModel({ openai: { tasks_model: 'fixture-custom-model' } }, {}, 'ALSO'), 'fixture-custom-model');
  assert.equal(resolveTasksModel({ openai: { tasks_model: 'gpt-5.4-mini' } }, {}, 'OTHER'), 'gpt-5.4-mini');
});

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

test('tenant AI uses its dedicated tasks model and returns one metered summary', async () => {
  let request;
  const analyzer = asistoTitleAnalyzer({ OPENAI_API_KEY_TAREAS_WS: 'fixture-key' }, {
    runtimeFor: async () => ({ openaiApiKey: 'fixture-key' }),
    configFor: async () => ({ CHAT_MODEL: 'conversational-model', openai: { tasks_model: 'fixture-tasks-model' } }),
    clientFor: () => ({ chat: { completions: { create: async input => {
      request = input;
      return { choices: [{ message: { content: JSON.stringify({ subject: 'Configurar impresora predeterminada', description: 'El cliente informó que la impresora no estaba configurada. Se indicó seleccionar la impresora correcta y confirmó que funcionó.' }) } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } };
    } } } }),
  });
  const result = await analyzer.run([{ fromMe:false, text:'No está configurada la impresora' }, { fromMe:true, text:'Probá seleccionando la impresora predeterminada' }, { fromMe:false, text:'Sí, genial' }], { tenantId:'ALSO' });
  assert.equal(request.model, 'fixture-tasks-model');
  assert.deepEqual(request.response_format, { type:'json_object' });
  assert.equal(result.subject, 'Configurar impresora predeterminada');
  assert.match(result.description, /confirmó que funcionó/);
  assert.equal(result.totalTokens, 50);
});

test('tasks default to gpt-4o-mini without inheriting the conversational model', async () => {
  let request;
  const analyzer = asistoTitleAnalyzer({ OPENAI_API_KEY_TAREAS_WS: 'fixture-key', CHAT_MODEL: 'expensive-conversational-model' }, {
    runtimeFor: async () => ({}), configFor: async () => ({ CHAT_MODEL: 'another-conversational-model' }),
    clientFor: () => ({ chat: { completions: { create: async input => {
      request = input;
      return { choices:[{ message:{ content:JSON.stringify({ subject:'Revisar impresión', description:'Se debe revisar la impresión.' }) } }], usage:{} };
    } } } }),
  });
  await analyzer.run([{ fromMe:false, text:'No imprime' }], { tenantId:'ALSO' });
  assert.equal(request.model, 'gpt-4o-mini');
});
