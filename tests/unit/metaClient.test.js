const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetaClient } = require('../../src/lib/meta');

test('normalizeMessages includes image metadata for payment proof processing', () => {
  const metaClient = createMetaClient({
    httpClient: {
      post: async () => ({ data: {} })
    }
  });

  const messages = metaClient.normalizeMessages({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Gonza' } }],
              messages: [
                {
                  id: 'wamid-1',
                  from: '56911111111',
                  type: 'image',
                  timestamp: '123',
                  image: {
                    id: 'media-1',
                    mime_type: 'image/png',
                    sha256: 'abc',
                    caption: 'comprobante'
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  });

  assert.equal(messages[0].type, 'image');
  assert.equal(messages[0].media.id, 'media-1');
  assert.equal(messages[0].media.mimeType, 'image/png');
});

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
