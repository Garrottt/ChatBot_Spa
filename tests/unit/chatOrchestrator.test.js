const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatOrchestrator } = require('../../src/services/chatOrchestrator');

function createDependencies() {
  const sentMessages = [];
  const client = { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', formalId: null };
  const conversation = { id: 'conv-1', currentIntent: 'unknown', currentStep: 'idle', collectedData: null, lastBookingId: null };

  return {
    sentMessages,
    orchestrator: createChatOrchestrator({
      openAIService: {
        classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2, entities: {} }),
        answerFaq: async (text) => `FAQ: ${text}`,
        craftBookingReply: async ({ fallbackMessage }) => fallbackMessage
      },
      clientService: {
        findOrCreateByWhatsappNumber: async () => client,
        updateClient: async (_id, data) => Object.assign(client, data)
      },
      conversationService: {
        getOrCreateActiveConversation: async () => conversation,
        updateConversation: async (_id, data) => Object.assign(conversation, data)
      },
      messageService: {
        findIncomingByProviderId: async () => null,
        createIncomingMessage: async () => ({}),
        createOutgoingMessage: async () => ({})
      },
      bookingService: {
        quoteAvailability: async () => ({
          service: { name: 'Masaje relajante' },
          slots: [{ startsAt: '2026-04-15T10:00:00.000Z' }]
        }),
        createBooking: async () => ({
          id: 'booking-1',
          service: { name: 'Masaje relajante' },
          scheduledAt: '2026-04-15T10:00:00.000Z'
        }),
        ensurePaymentLink: async () => ({ url: 'https://pay.test/booking-1' })
      },
      serviceCatalogService: {
        findServiceFromText: async () => null,
        listActiveServices: async () => [
          { name: 'Masaje relajante', description: 'Relajacion', durationMinutes: 60, price: 35000, currency: 'CLP' }
        ]
      },
      metaClient: {
        sendTextMessage: async (_to, text) => {
          sentMessages.push({ kind: 'text', text });
        },
        sendButtonsMessage: async (_to, bodyText, buttons) => {
          sentMessages.push({ kind: 'buttons', bodyText, buttons });
        },
        sendListMessage: async (_to, bodyText, buttonText, sections) => {
          sentMessages.push({ kind: 'list', bodyText, buttonText, sections });
        }
      }
    })
  };
}

test('booking intent asks for missing formal id instead of falling back', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-1',
    from: '56911111111',
    type: 'text',
    text: 'quiero reservar una cita',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null
  });

  assert.match(sentMessages[0].text, /RUT o identificador/i);
});

test('business info question is answered as faq even if model intent is poor', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-2',
    from: '56911111111',
    type: 'text',
    text: 'como se llama el spa y donde esta',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null
  });

  assert.match(sentMessages[0].text, /FAQ:/);
});

test('invalid date while awaiting date asks for YYYY-MM-DD instead of crashing', async () => {
  const sentMessages = [];
  const client = { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', formalId: '210931468' };
  const conversation = { id: 'conv-1', currentIntent: 'booking', currentStep: 'awaiting_date', collectedData: { serviceId: 'svc-1' }, lastBookingId: null };

  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'booking', confidence: 0.99, entities: {} }),
      answerFaq: async (text) => `FAQ: ${text}`,
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => client,
      updateClient: async () => client
    },
    conversationService: {
      getOrCreateActiveConversation: async () => conversation,
      updateConversation: async (_id, data) => Object.assign(conversation, data)
    },
    messageService: {
      findIncomingByProviderId: async () => null,
      createIncomingMessage: async () => ({}),
      createOutgoingMessage: async () => ({})
    },
    bookingService: {
      quoteAvailability: async () => {
        throw new Error('should not be called');
      },
      createBooking: async () => ({}),
      ensurePaymentLink: async () => ({})
    },
    serviceCatalogService: {
      findServiceFromText: async () => null,
      listActiveServices: async () => []
    },
    metaClient: {
      sendTextMessage: async (_to, text) => {
        sentMessages.push({ kind: 'text', text });
      },
      sendButtonsMessage: async (_to, bodyText, buttons) => {
        sentMessages.push({ kind: 'buttons', bodyText, buttons });
      },
      sendListMessage: async (_to, bodyText, buttonText, sections) => {
        sentMessages.push({ kind: 'list', bodyText, buttonText, sections });
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-4',
    from: '56911111111',
    type: 'text',
    text: 'el domingo',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null
  });

  assert.match(sentMessages[0].text, /YYYY-MM-DD/);
});

test('main menu uses interactive list with spa options', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-5',
    from: '56911111111',
    type: 'text',
    text: 'hola',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.equal(sentMessages[0].sections[0].rows.length, 5);
  assert.match(sentMessages[0].bodyText, /Spa Ikigai Ovalle/i);
});

test('service selection can be done through interactive list option ids', async () => {
  const sentMessages = [];
  const client = { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', formalId: '210931468' };
  const conversation = { id: 'conv-1', currentIntent: 'booking', currentStep: 'awaiting_service', collectedData: null, lastBookingId: null };

  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2, entities: {} }),
      answerFaq: async (text) => `FAQ: ${text}`,
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => client,
      updateClient: async (_id, data) => Object.assign(client, data)
    },
    conversationService: {
      getOrCreateActiveConversation: async () => conversation,
      updateConversation: async (_id, data) => Object.assign(conversation, data)
    },
    messageService: {
      findIncomingByProviderId: async () => null,
      createIncomingMessage: async () => ({}),
      createOutgoingMessage: async () => ({})
    },
    bookingService: {
      quoteAvailability: async () => ({
        service: { name: 'Masaje relajante', durationMinutes: 60 },
        slots: [{ startsAt: '2026-04-15T10:00:00.000Z' }]
      }),
      createBooking: async () => ({
        id: 'booking-1',
        service: { name: 'Masaje relajante' },
        scheduledAt: '2026-04-15T10:00:00.000Z'
      }),
      ensurePaymentLink: async () => ({ url: 'https://pay.test/booking-1' })
    },
    serviceCatalogService: {
      findServiceFromText: async () => null,
      getServiceById: async () => ({ id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, price: 35000, currency: 'CLP' }),
      listActiveServices: async () => [
        { id: 'svc-1', name: 'Masaje relajante', description: 'Relajacion', durationMinutes: 60, price: 35000, currency: 'CLP' }
      ]
    },
    metaClient: {
      sendTextMessage: async (_to, text) => {
        sentMessages.push({ kind: 'text', text });
      },
      sendButtonsMessage: async (_to, bodyText, buttons) => {
        sentMessages.push({ kind: 'buttons', bodyText, buttons });
      },
      sendListMessage: async (_to, bodyText, buttonText, sections) => {
        sentMessages.push({ kind: 'list', bodyText, buttonText, sections });
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-6',
    from: '56911111111',
    type: 'interactive',
    text: 'Masaje relajante',
    selectedId: 'service:svc-1',
    timestamp: String(Date.now()),
    profileName: 'Gonza'
  });

  assert.match(sentMessages[0].text, /YYYY-MM-DD/);
});

test('duplicate incoming provider ids are ignored and do not send another reply', async () => {
  const sentMessages = [];
  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'booking', confidence: 0.99, entities: {} }),
      answerFaq: async () => 'faq',
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => ({ id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', formalId: null }),
      updateClient: async () => ({})
    },
    conversationService: {
      getOrCreateActiveConversation: async () => ({ id: 'conv-1', currentIntent: 'unknown', currentStep: 'idle', collectedData: null, lastBookingId: null }),
      updateConversation: async () => ({})
    },
    messageService: {
      findIncomingByProviderId: async () => ({ id: 'msg-1' }),
      createIncomingMessage: async () => {
        throw new Error('should not create duplicate');
      },
      createOutgoingMessage: async () => {
        throw new Error('should not answer duplicate');
      }
    },
    bookingService: {
      quoteAvailability: async () => ({}),
      createBooking: async () => ({}),
      ensurePaymentLink: async () => ({})
    },
    serviceCatalogService: {
      findServiceFromText: async () => null,
      listActiveServices: async () => []
    },
    metaClient: {
      sendTextMessage: async (_to, text) => {
        sentMessages.push({ kind: 'text', text });
      },
      sendButtonsMessage: async () => {
        sentMessages.push({ kind: 'buttons' });
      },
      sendListMessage: async () => {
        sentMessages.push({ kind: 'list' });
      }
    }
  });

  const reply = await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-duplicate',
    from: '56911111111',
    type: 'text',
    text: 'hola',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null
  });

  assert.equal(reply.intent, 'duplicate');
  assert.equal(sentMessages.length, 0);
});
