const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatOrchestrator } = require('../../src/services/chatOrchestrator');
const { AppError } = require('../../src/lib/errors');

test('calendar lookup errors become user-facing replies instead of crashing the webhook', async () => {
  const sentMessages = [];
  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'booking', confidence: 0.99, entities: {} }),
      answerFaq: async () => 'faq',
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => ({ id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', formalId: '210931468' }),
      updateClient: async () => ({})
    },
    conversationService: {
      getOrCreateActiveConversation: async () => ({
        id: 'conv-1',
        currentIntent: 'booking',
        currentStep: 'awaiting_date',
        collectedData: { serviceId: 'svc-1' },
        lastBookingId: null
      }),
      updateConversation: async () => ({})
    },
    messageService: {
      findIncomingByProviderId: async () => null,
      createIncomingMessage: async () => ({}),
      createOutgoingMessage: async () => ({})
    },
    bookingService: {
      quoteAvailability: async () => {
        const error = new AppError(
          'No pude acceder al calendario configurado. Revisa GOOGLE_CALENDAR_DEFAULT_ID y que el calendario este compartido con la cuenta de servicio.',
          503
        );
        throw error;
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
        sentMessages.push(text);
      }
    }
  });

  const reply = await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-3',
    from: '56911111111',
    type: 'text',
    text: '2026-04-12',
    timestamp: String(Date.now()),
    profileName: 'Gonza'
  });

  assert.match(reply.text, /calendario configurado/i);
  assert.match(sentMessages[0], /calendario configurado/i);
});
