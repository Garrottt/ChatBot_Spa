const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');

const { createMediaService } = require('../../src/services/mediaService');

test('persistIncomingMedia stores mediaUrl and caches the downloaded file', async () => {
  const updatedMessages = [];
  const messageRecord = {
    id: 'message-1',
    metadata: {
      media: {
        id: 'media-1',
        mimeType: 'image/png'
      }
    }
  };

  const mediaService = createMediaService({
    messageService: {
      updateMessage: async (_id, data) => {
        updatedMessages.push(data);
        return data;
      }
    },
    metaClient: {
      downloadMedia: async () => ({
        buffer: Buffer.from('png-image'),
        mimeType: 'image/png',
        sha256: 'abc'
      })
    }
  });

  const result = await mediaService.persistIncomingMedia({
    messageRecord,
    media: {
      id: 'media-1',
      mimeType: 'image/png',
      caption: 'comprobante'
    }
  });

  assert.match(result.mediaUrl, /\/api\/media\/messages\/message-1$/);
  assert.equal(updatedMessages.length, 2);

  const storagePath = updatedMessages[1].metadata.media.storagePath;
  const fileBuffer = await fs.readFile(storagePath);
  assert.equal(fileBuffer.toString(), 'png-image');

  await fs.rm(path.dirname(storagePath), { recursive: true, force: true });
});

test('getMessageMedia falls back to Meta download when local cache is missing', async () => {
  let updatedMessage = null;

  const mediaService = createMediaService({
    messageService: {
      findById: async () => ({
        id: 'message-2',
        mediaUrl: 'http://localhost:3000/api/media/messages/message-2',
        metadata: {
          media: {
            id: 'media-2',
            mimeType: 'image/jpeg',
            storagePath: path.join(process.cwd(), 'uploads/message-media/non-existent.jpg')
          }
        }
      }),
      updateMessage: async (_id, data) => {
        updatedMessage = data;
        return data;
      }
    },
    metaClient: {
      downloadMedia: async () => ({
        buffer: Buffer.from('jpeg-image'),
        mimeType: 'image/jpeg',
        sha256: 'def'
      })
    }
  });

  const result = await mediaService.getMessageMedia('message-2');

  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.buffer.toString(), 'jpeg-image');
  assert.ok(updatedMessage.metadata.media.storagePath);

  await fs.rm(path.dirname(updatedMessage.metadata.media.storagePath), { recursive: true, force: true });
});
