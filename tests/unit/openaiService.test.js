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
