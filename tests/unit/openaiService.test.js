const test = require('node:test');
const assert = require('node:assert/strict');

const { createOpenAIService } = require('../../src/lib/openai');

test('answerFaq returns exact service price for matched service questions', async () => {
  const service = createOpenAIService();

  const answer = await service.answerFaq('cuanto vale el masaje relajante?', [
    {
      id: 'svc-1',
      code: 'MASAJE-RELAX',
      name: 'Masaje relajante',
      description: 'Masaje descontracturante suave.',
      price: 100,
      currency: 'CLP',
      durationMinutes: 60
    }
  ]);

  assert.match(answer, /\$100 CLP/);
  assert.doesNotMatch(answer, /100\.000/);
});

test('answerFaq returns exact prices for service catalog questions', async () => {
  const service = createOpenAIService();

  const answer = await service.answerFaq('que servicios tienen disponibles?', [
    {
      id: 'svc-1',
      code: 'MASAJE-RELAX',
      name: 'Masaje relajante',
      description: 'Masaje descontracturante suave.',
      price: 100,
      currency: 'CLP',
      durationMinutes: 60
    }
  ]);

  assert.match(answer, /\$100 CLP/);
  assert.doesNotMatch(answer, /100\.000/);
});

test('answerFaq uses service context for generic price questions', async () => {
  const service = createOpenAIService();

  const answer = await service.answerFaq(
    'cual es el valor?',
    [
      {
        id: 'svc-1',
        code: 'LIMPIEZA-FACIAL',
        name: 'Limpieza facial profunda',
        description: 'Limpieza completa.',
        price: 197,
        currency: 'CLP',
        durationMinutes: 75
      }
    ],
    {
      service: {
        id: 'svc-1',
        code: 'LIMPIEZA-FACIAL',
        name: 'Limpieza facial profunda',
        description: 'Limpieza completa.',
        price: 197,
        currency: 'CLP',
        durationMinutes: 75
      }
    }
  );

  assert.match(answer, /\$197 CLP/);
  assert.doesNotMatch(answer, /197\.000/);
});
