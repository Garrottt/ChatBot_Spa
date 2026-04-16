const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createChatwootClient } = require('../../src/lib/chatwoot');
const { createChatwootService } = require('../../src/services/chatwootService');

test('captureIncomingMessage creates contact, conversation and forwards inbound WhatsApp text to Chatwoot', async () => {
  const calls = [];
  const service = createChatwootService({
    chatwootClient: {
      isConfigured: () => true,
      createContact: async (payload) => {
        calls.push({ type: 'contact', payload });
        return {
          id: 10,
          source_id: 'source-1',
          contact_inboxes: [{ inbox_id: 22, source_id: 'source-1' }]
        };
      },
      createConversation: async (payload) => {
        calls.push({ type: 'conversation', payload });
        return { id: 99 };
      },
      createMessage: async (payload) => {
        calls.push({ type: 'message', payload });
        return { id: 123 };
      }
    },
    conversationService: {
      mergeCollectedData: async () => ({})
    },
    messageService: {
      findOutgoingByProviderId: async () => null,
      createOutgoingMessage: async () => ({})
    },
    metaClient: {
      sendTextMessage: async () => ({})
    }
  });

  const conversation = { id: 'conv-1', collectedData: {} };
  const client = { whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez' };

  await service.captureIncomingMessage({
    client,
    conversation,
    message: {
      type: 'text',
      text: 'Hola desde WhatsApp'
    }
  });

  assert.equal(calls[0].type, 'contact');
  assert.equal(calls[1].type, 'conversation');
  assert.equal(calls[2].type, 'message');
  assert.equal(calls[2].payload.messageType, 'incoming');
  assert.equal(calls[2].payload.content, 'Hola desde WhatsApp');
  assert.equal(conversation.collectedData.chatwoot.conversationId, 99);
});

test('handleWebhookEvent forwards outgoing Chatwoot message to WhatsApp once', async () => {
  const forwarded = [];
  const saved = [];
  const service = createChatwootService({
    chatwootClient: {
      isConfigured: () => true
    },
    conversationService: {
      findByChatwootConversationId: async () => ({
        id: 'conv-1',
        clientId: 'client-1',
        client: { whatsappNumber: '56911111111' }
      })
    },
    messageService: {
      findOutgoingByProviderId: async () => null,
      createOutgoingMessage: async (payload) => {
        saved.push(payload);
        return {};
      }
    },
    metaClient: {
      sendTextMessage: async (to, text) => {
        forwarded.push({ to, text });
      }
    }
  });

  const result = await service.handleWebhookEvent({
    event: 'message_created',
    conversation: { id: 99 },
    message: {
      id: 777,
      message_type: 'outgoing',
      private: false,
      content: 'Hola desde agente'
    }
  });

  assert.equal(result.forwarded, true);
  assert.equal(forwarded[0].to, '56911111111');
  assert.equal(forwarded[0].text, 'Hola desde agente');
  assert.equal(saved[0].providerId, 'chatwoot:777');
});

test('handleWebhookEvent accepts Chatwoot agent messages even when message_type is null', async () => {
  const forwarded = [];
  const service = createChatwootService({
    chatwootClient: {
      isConfigured: () => true
    },
    conversationService: {
      findByChatwootConversationId: async () => ({
        id: 'conv-1',
        clientId: 'client-1',
        client: { whatsappNumber: '56911111111' }
      })
    },
    messageService: {
      findOutgoingByProviderId: async () => null,
      createOutgoingMessage: async () => ({})
    },
    metaClient: {
      sendTextMessage: async (_to, text) => {
        forwarded.push(text);
      }
    }
  });

  const result = await service.handleWebhookEvent({
    event: 'message_created',
    sender: { type: 'user' },
    conversation: { id: 99 },
    message: {
      id: 778,
      message_type: null,
      private: false,
      content: 'Respuesta del agente'
    }
  });

  assert.equal(result.forwarded, true);
  assert.equal(forwarded[0], 'Respuesta del agente');
});

test('handleWebhookEvent accepts flat Chatwoot payloads where content is at the top level', async () => {
  const forwarded = [];
  const service = createChatwootService({
    chatwootClient: {
      isConfigured: () => true
    },
    conversationService: {
      findByChatwootConversationId: async () => ({
        id: 'conv-1',
        clientId: 'client-1',
        client: { whatsappNumber: '56911111111' }
      })
    },
    messageService: {
      findOutgoingByProviderId: async () => null,
      createOutgoingMessage: async () => ({})
    },
    metaClient: {
      sendTextMessage: async (_to, text) => {
        forwarded.push(text);
      }
    }
  });

  const result = await service.handleWebhookEvent({
    event: 'message_created',
    id: 779,
    content: 'Mensaje plano del agente',
    private: false,
    sender: { type: 'user' },
    conversation: { id: 99 }
  });

  assert.equal(result.forwarded, true);
  assert.equal(forwarded[0], 'Mensaje plano del agente');
});

test('chatwoot client verifies webhook signature using timestamp and raw body', () => {
  process.env.CHATWOOT_WEBHOOK_SECRET = 'spa-test-secret';
  delete require.cache[require.resolve('../../src/config/env')];
  delete require.cache[require.resolve('../../src/lib/chatwoot')];

  const { createChatwootClient: createFreshChatwootClient } = require('../../src/lib/chatwoot');
  const client = createFreshChatwootClient();
  const timestamp = '1713227400';
  const rawBody = Buffer.from('{"event":"message_created","message":{"id":1}}');
  const signature = `sha256=${crypto.createHmac('sha256', 'spa-test-secret').update(`${timestamp}.${rawBody}`).digest('hex')}`;

  assert.equal(client.verifySignature(signature, rawBody, timestamp), true);
});
