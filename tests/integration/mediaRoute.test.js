const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');

test('media route returns stored message media for CRM previews', async () => {
  const app = createApp({
    mediaService: {
      getMessageMedia: async (messageId) => {
        assert.equal(messageId, 'message-1');
        return {
          buffer: Buffer.from('image-body'),
          mimeType: 'image/png'
        };
      }
    }
  });

  const response = await request(app)
    .get('/api/media/messages/message-1')
    .expect(200);

  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(Buffer.from(response.body).toString(), 'image-body');
});
