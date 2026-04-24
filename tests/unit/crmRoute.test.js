const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');

test('crm send-message endpoint forwards a manual reply and stores it as outgoing', async () => {
  const sentPayloads = [];
  const savedMessages = [];

  const app = createApp({
    metaClient: {
      sendTextMessage: async (to, content) => {
        sentPayloads.push({ to, content });
      }
    },
    messageService: {
      createOutgoingMessage: async (payload) => {
        savedMessages.push(payload);
        return {};
      }
    },
    conversationService: {
      findById: async () => ({
        id: 'conv-1',
        clientId: 'client-1',
        client: {
          whatsappNumber: '56911111111'
        }
      }),
      getOrCreateActiveConversation: async () => ({
        id: 'conv-1',
        clientId: 'client-1'
      })
    },
    clientService: {
      getClientById: async () => ({
        id: 'client-1',
        whatsappNumber: '56911111111'
      })
    },
    chatwootClient: { verifySignature: () => true },
    chatwootService: { handleWebhookEvent: async () => ({}) },
    chatOrchestrator: { handleIncomingMessage: async () => ({}) }
  });

  const response = await request(app)
    .post('/api/crm/send-message')
    .send({
      whatsappNumber: '56911111111',
      content: 'Mensaje manual desde CRM',
      conversationId: 'conv-1',
      clientId: 'client-1'
    });

  assert.equal(response.status, 200);
  assert.deepEqual(sentPayloads[0], {
    to: '56911111111',
    content: 'Mensaje manual desde CRM'
  });
  assert.equal(savedMessages[0].conversationId, 'conv-1');
  assert.equal(savedMessages[0].clientId, 'client-1');
  assert.equal(savedMessages[0].metadata.source, 'crm');
});

test('crm send-message endpoint resolves a conversation when the CRM does not send conversationId', async () => {
  const sentPayloads = [];
  const app = createApp({
    metaClient: {
      sendTextMessage: async (to, content) => {
        sentPayloads.push({ to, content });
      }
    },
    messageService: {
      createOutgoingMessage: async () => ({})
    },
    conversationService: {
      getOrCreateActiveConversation: async () => ({
        id: 'conv-latest',
        clientId: 'client-1'
      }),
      findById: async (id) => ({
        id,
        clientId: 'client-1',
        client: {
          whatsappNumber: '56911111111'
        }
      })
    },
    clientService: {
      getClientById: async () => ({
        id: 'client-1',
        whatsappNumber: '56911111111'
      })
    },
    chatwootClient: { verifySignature: () => true },
    chatwootService: { handleWebhookEvent: async () => ({}) },
    chatOrchestrator: { handleIncomingMessage: async () => ({}) }
  });

  const response = await request(app)
    .post('/api/crm/send-message')
    .send({
      whatsappNumber: '56911111111',
      content: 'Mensaje sin conversacion previa',
      clientId: 'client-1'
    });

  assert.equal(response.status, 200);
  assert.equal(sentPayloads[0].to, '56911111111');
  assert.equal(sentPayloads[0].content, 'Mensaje sin conversacion previa');
});
