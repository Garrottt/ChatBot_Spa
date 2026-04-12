const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetaClient } = require('../../src/lib/meta');

test('sendTextMessage wraps WhatsApp API errors in AppError', async () => {
  const metaClient = createMetaClient({
    httpClient: {
      post: async () => {
        const error = new Error('Request failed with status code 400');
        error.response = {
          status: 400,
          data: { error: { message: 'Bad request' } }
        };
        throw error;
      }
    }
  });

  await assert.rejects(
    () => metaClient.sendTextMessage('56911111111', 'hola'),
    /No pude enviar la respuesta por WhatsApp/
  );
});
