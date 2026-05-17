const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatOrchestrator } = require('../../src/services/chatOrchestrator');

function createDependencies(overrides = {}) {
  const sentMessages = [];
  const client = overrides.client || { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: null };
  const conversation = overrides.conversation || {
    id: 'conv-1',
    currentIntent: 'unknown',
    currentStep: 'idle',
    collectedData: null,
    lastBookingId: null,
    botPaused: false,
    takenOverByAgent: false
  };

  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2, entities: {} }),
      answerFaq: async (text) => `FAQ: ${text}`,
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage,
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        confidence: 0.9
      }),
      ...(overrides.openAIService || {})
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => client,
      updateClient: async (_id, data) => Object.assign(client, data),
      ...(overrides.clientService || {})
    },
    conversationService: {
      getOrCreateActiveConversation: async () => conversation,
      updateConversation: async (_id, data) => Object.assign(conversation, data),
      touchConversation: async () => ({}),
      resumeBotConversation: async () => Object.assign(conversation, {
        botPaused: false,
        takenOverByAgent: false,
        takenOverAt: null,
        takenOverByUserId: null
      }),
      isBotPaused: (currentConversation) => Boolean(currentConversation.botPaused || currentConversation.takenOverByAgent),
      shouldAutoResume: () => false,
      ...(overrides.conversationService || {})
    },
    messageService: {
      findIncomingByProviderId: async () => null,
      createIncomingMessage: async ({ metadata, messageType, providerId, content, conversationId, clientId }) => ({
        id: 'message-1',
        metadata,
        messageType,
        providerId,
        content,
        conversationId,
        clientId
      }),
      createOutgoingMessage: async () => ({}),
      ...(overrides.messageService || {})
    },
    bookingService: {
      findUpcomingBookingsForClient: async () => [],
      quoteAvailability: async () => ({
        service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, price: 35000, currency: 'CLP' },
        slots: [{ startsAt: '2026-04-15T10:00:00.000Z' }]
      }),
      createPendingBooking: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        service: { name: 'Masaje relajante', currency: 'CLP' }
      }),
      ensurePaymentLink: async () => ({ url: 'https://pay.test/booking-1' }),
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-15T12:00:00.000Z',
        holdExpiresAt: '2026-04-15T12:10:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      }),
      rejectPaymentProof: async () => ({}),
      confirmPendingBooking: async () => ({
        id: 'booking-1',
        service: { name: 'Masaje relajante' },
        scheduledAt: '2026-04-15T10:00:00.000Z'
      }),
      createBooking: async () => ({
        id: 'booking-1',
        service: { name: 'Masaje relajante' },
        scheduledAt: '2026-04-15T10:00:00.000Z'
      }),
      cancelBooking: async () => ({
        id: 'booking-1',
        service: { name: 'Masaje relajante' },
        scheduledAt: '2026-04-15T10:00:00.000Z'
      }),
      ...(overrides.bookingService || {})
    },
    campaignService: {
      getOfferById: async (offerId) => offerId ? ({
        id: offerId,
        name: 'Promo masaje',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        customText: null,
        serviceId: 'svc-1',
        specialistId: null,
        active: true,
        startsAt: '2026-04-01T00:00:00.000Z',
        endsAt: '2026-06-01T00:00:00.000Z'
      }) : null,
      markRecipientSent: async () => ({}),
      markRecipientFailed: async () => ({}),
      markRecipientResponded: async () => ({}),
      markRecipientBooked: async () => ({}),
      markRecipientOptedOut: async () => ({}),
      ...(overrides.campaignService || {})
    },
    serviceCatalogService: {
      findServiceFromText: async () => null,
      getServiceById: async () => ({ id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, price: 35000, currency: 'CLP' }),
      listActiveServices: async () => [
        { id: 'svc-1', name: 'Masaje relajante', description: 'Relajacion', durationMinutes: 60, price: 35000, currency: 'CLP' }
      ],
      ...(overrides.serviceCatalogService || {})
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
      },
      downloadMedia: async () => ({
        buffer: Buffer.from('image-bytes'),
        mimeType: 'image/png'
      }),
      ...(overrides.metaClient || {})
    },
    mediaService: {
      persistIncomingMedia: async () => ({ mediaUrl: 'http://localhost:3000/api/media/messages/message-1' }),
      ...(overrides.mediaService || {})
    },
    ...(overrides.dependencies || {})
  });

  return {
    sentMessages,
    client,
    conversation,
    orchestrator
  };
}

test('booking intent starts by showing services even if personal data is incomplete', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-1',
    from: '56911111111',
    type: 'text',
    text: 'quiero reservar una cita',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.match(sentMessages[0].bodyText, /servicio/i);
});

test('service selection asks for the client name before requesting the date', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: null, lastName: null, formalId: null },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_service',
      collectedData: null,
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-1b',
    from: '56911111111',
    type: 'interactive',
    text: 'Masaje relajante',
    selectedId: 'service:svc-1',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /nombre y apellidos/i);
});

test('full name entry stores name and last name together before asking for the RUT', async () => {
  const { orchestrator, sentMessages, client } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: null, lastName: null, formalId: null },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_name',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-full-name',
    from: '56911111111',
    type: 'text',
    text: 'Gonza Perez',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(client.name, 'Gonza');
  assert.equal(client.lastName, 'Perez');
  assert.match(sentMessages[0].text, /RUT o identificador/i);
});

test('incoming image persists a stable media url for CRM rendering', async () => {
  let persistedMedia = null;
  const { orchestrator } = createDependencies({
    mediaService: {
      persistIncomingMedia: async (payload) => {
        persistedMedia = payload;
        return { mediaUrl: 'http://localhost:3000/api/media/messages/message-1' };
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-image-1',
    from: '56911111111',
    type: 'image',
    text: 'comprobante',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: {
      id: 'media-1',
      mimeType: 'image/png',
      sha256: 'abc',
      caption: 'comprobante'
    }
  });

  assert.equal(persistedMedia.media.id, 'media-1');
  assert.equal(persistedMedia.messageRecord.id, 'message-1');
});

test('after selecting time with missing formal id the bot asks for personal data', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_time',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-2',
    from: '56911111111',
    type: 'interactive',
    text: '10:00',
    selectedId: 'slot:10:00',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.match(sentMessages[0].text, /RUT o identificador/i);
});

test('after selecting time with complete client data the bot asks who will make the payment', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_time',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-role',
    from: '56911111111',
    type: 'interactive',
    text: '10:00',
    selectedId: 'slot:10:00',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /realizara el pago/i);
});

test('self payer selection shows the stored payer data before payment method', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payer_role',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-self',
    from: '56911111111',
    type: 'interactive',
    text: 'Yo hare el pago',
    selectedId: 'payer:self',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /Tengo estos datos guardados sobre usted/i);
  assert.match(sentMessages[0].bodyText, /RUT: 210931468/i);
});

test('other payer flow collects name, RUT and email before payment method', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payer_role',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-other-1',
    from: '56911111111',
    type: 'interactive',
    text: 'Otra persona',
    selectedId: 'payer:other',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.match(sentMessages[0].text, /nombre y apellidos de la persona que realizara el pago/i);

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-other-2',
    from: '56911111111',
    type: 'text',
    text: 'Maria Lopez',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.match(sentMessages[1].text, /RUT o identificador/i);

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-other-3',
    from: '56911111111',
    type: 'text',
    text: '12345678-9',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.match(sentMessages[2].text, /correo electronico/i);

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payer-other-4',
    from: '56911111111',
    type: 'text',
    text: 'maria@example.com',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[3].kind, 'list');
  assert.match(sentMessages[3].buttonText, /medio de pago/i);
  assert.equal(conversation.collectedData.payerEmail, 'maria@example.com');
});

test('payment method selection creates a pending booking and sends the payment link', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_method',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-3',
    from: '56911111111',
    type: 'interactive',
    text: 'Debito o credito',
    selectedId: 'payment:card',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.match(sentMessages[0].text, /https:\/\/pay\.test\/booking-1/);
  assert.match(sentMessages[0].text, /comprobante/i);
});

test('transfer payment selection sends bank details instead of a payment link', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_method',
      collectedData: { serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: null
    },
    bookingService: {
      ensurePaymentLink: async () => {
        throw new Error('should not create payment link for transfer');
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-transfer',
    from: '56911111111',
    type: 'interactive',
    text: 'Transferencia',
    selectedId: 'payment:transfer',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.match(sentMessages[0].text, /Aqui estan los datos bancarios para realizar la transferencia del abono/i);
  assert.match(sentMessages[0].text, /Numero de cuenta: 1020190317/i);
  assert.match(sentMessages[0].text, /Mercado Pago/i);
  assert.doesNotMatch(sentMessages[0].text, /Datos bancarios para transferir:[\s\S]*Datos bancarios para transferir:/i);
});

test('payment amount question during proof wait answers with the exact remaining deposit', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2099-04-30T23:20:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payment-amount',
    from: '56911111111',
    type: 'text',
    text: 'cuanto es lo que debo de pagar',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /abono requerido/i);
  assert.match(sentMessages[0].text, /100 CLP/i);
});

test('short payment amount question during proof wait still answers with the pending deposit', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2099-04-30T23:20:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payment-amount-short',
    from: '56911111111',
    type: 'text',
    text: 'y cuanto es?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /abono requerido/i);
  assert.match(sentMessages[0].text, /100 CLP/i);
});

test('combined payment question during proof wait answers both time left and pending amount', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2099-04-30T23:20:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payment-combined',
    from: '56911111111',
    type: 'text',
    text: 'Cuanto tiempo me queda y cuanto es lo que debo de pagar?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /Le quedan aproximadamente/i);
  assert.match(sentMessages[0].text, /abono requerido/i);
  assert.match(sentMessages[0].text, /100 CLP/i);
});

test('payment destination question during proof wait returns bank details', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2099-04-30T23:20:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-payment-destination',
    from: '56911111111',
    type: 'text',
    text: 'a que cuenta debo transferir',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /datos para realizar el abono/i);
  assert.match(sentMessages[0].text, /Numero de cuenta: 1020190317/i);
});

test('expired hold returns buttons instead of falling back to the main menu', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'main_menu',
      collectedData: { bookingId: 'booking-1', holdExpiredBookingId: 'booking-1' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        paymentStatus: 'EXPIRED',
        status: 'CANCELLED',
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2026-04-30T23:10:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-hold-expired',
    from: '56911111111',
    type: 'text',
    text: 'aun puedo pagar',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
});

test('hold expired fallback still responds with buttons after the reminder flow updates state', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'hold_expired',
      collectedData: { bookingId: 'booking-1', holdExpiredBookingId: 'booking-1' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        paymentStatus: 'EXPIRED',
        status: 'CANCELLED',
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2026-04-30T23:10:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-hold-expired-2',
    from: '56911111111',
    type: 'text',
    text: 'cuanto tiempo me queda?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.equal(sentMessages[0].buttons[0].id, 'menu:main');
  assert.equal(sentMessages[0].buttons[1].id, 'menu:book');
});

test('booking flow is not blocked by an old expired hold once the user chooses a new service', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_service',
      collectedData: { bookingId: 'booking-expired', holdExpiredBookingId: 'booking-expired' },
      lastBookingId: 'booking-expired'
    },
    bookingService: {
      getBookingById: async () => ({
        id: 'booking-expired',
        paymentStatus: 'EXPIRED',
        status: 'CANCELLED',
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        holdExpiresAt: '2026-04-30T23:10:00.000Z'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-booking-new',
    from: '56911111111',
    type: 'interactive',
    text: 'Masaje relajante',
    selectedId: 'service:svc-1',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
});

test('service selection continues booking flow even when coming from consultation context', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_service',
      collectedData: null,
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-3b',
    from: '56911111111',
    type: 'interactive',
    text: 'Circuito spa',
    selectedId: 'service:svc-1',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.match(sentMessages[0].bodyText, /dia/i);
});

test('date selection explains when the service has no assigned specialist and offers buttons to choose another service', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_date',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    },
    bookingService: {
      quoteAvailability: async () => ({
        service: { id: 'svc-1', name: 'Masaje de Espalda', durationMinutes: 60, price: 1000, currency: 'CLP' },
        slots: [],
        unavailableReason: 'NO_SPECIALISTS'
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-no-specialist',
    from: '56911111111',
    type: 'interactive',
    text: 'Jueves 30 Abril',
    selectedId: 'date:2026-04-30',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /no tiene un especialista asignado/i);
  assert.match(sentMessages[0].bodyText, /no se encuentra disponible/i);
  assert.equal(sentMessages[0].buttons[0].id, 'menu:book');
  assert.equal(sentMessages[0].buttons[1].id, 'menu:main');
  assert.equal(conversation.currentStep, 'awaiting_service');
});

test('date selection explains clearly when no schedules are available for that day', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_date',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    },
    bookingService: {
      quoteAvailability: async () => ({
        service: { id: 'svc-1', name: 'Masaje de Espalda', durationMinutes: 60, price: 1000, currency: 'CLP' },
        slots: [],
        unavailableReason: null
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-no-slots',
    from: '56911111111',
    type: 'interactive',
    text: 'Jueves 30 Abril',
    selectedId: 'date:2026-04-30',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /(no hay horarios disponibles|no quedan horarios disponibles)/i);
  assert.match(sentMessages[0].bodyText, /(otras fechas|otra fecha|cambiar de servicio)/i);
  assert.equal(sentMessages[0].buttons[0].id, 'retrydates:Masaje de Espalda');
  assert.equal(sentMessages[0].buttons[1].id, 'menu:book');
  assert.equal(conversation.currentStep, 'awaiting_date');
});

test('retry dates button reopens the available dates list for the same booking flow', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_date',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-retry-dates',
    from: '56911111111',
    type: 'interactive',
    text: 'Ver fechas',
    selectedId: 'retrydates:Masaje de Espalda',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.match(sentMessages[0].bodyText, /elija el dia que prefiera/i);
});

test('valid proof image confirms the booking after payment validation', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-15T12:00:00.000Z',
        holdExpiresAt: '2026-04-15T12:10:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        transactionId: '156387031993',
        confidence: 0.9
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-4',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-1',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('booking confirmation message formats the confirmed schedule in America/Santiago timezone', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-30T21:00:00.000Z',
        holdExpiresAt: '2026-04-30T21:10:00.000Z',
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      }),
      confirmPendingBooking: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        scheduledAt: '2026-04-30T22:00:00.000Z',
        service: { name: 'Masaje de Espalda', currency: 'CLP' }
      })
    },
    openAIService: {
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage,
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-30T17:05:00-04:00',
        transactionId: '156387031993',
        confidence: 0.95
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-local-time',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-local-time',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /2026-04-30 18:00/);
  assert.doesNotMatch(sentMessages[0].bodyText, /2026-04-30 22:00/);
});

test('invalid proof image asks the client to resend the receipt', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: false,
        reason: 'La imagen no parece un comprobante legible.',
        detectedAmount: null,
        payerName: null,
        payerFormalId: null,
        paymentTimestamp: null,
        confidence: 0.2
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-4b',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-1',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /No pude validar el comprobante/i);
});

test('business info question is answered as faq even if model intent is poor', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-5',
    from: '56911111111',
    type: 'text',
    text: 'como se llama el spa y donde esta',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.match(sentMessages[0].text, /FAQ:/);
});

test('opening hours question answers the schedule instead of starting booking services', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    openAIService: {
      answerFaq: async () => 'Nuestro horario de atencion es Lunes a Sabado de 09:00 a 20:00.'
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-opening-hours',
    from: '56911111111',
    type: 'text',
    text: 'cual es el horario de atencion?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /horario de atencion/i);
  assert.doesNotMatch(sentMessages[0].text, /servicios disponibles/i);
});

test('invalid date while awaiting date asks the client to choose from the date list instead of crashing', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_date',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    },
    bookingService: {
      quoteAvailability: async () => {
        throw new Error('should not be called');
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-6',
    from: '56911111111',
    type: 'text',
    text: 'el domingo',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.match(sentMessages[0].bodyText, /dia/i);
});

test('main menu uses interactive list with spa options', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-7',
    from: '56911111111',
    type: 'text',
    text: 'hola',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.equal(sentMessages[0].sections[0].rows.length, 5);
  assert.match(sentMessages[0].bodyText, /Spa Ikigai Ovalle/i);
});

test('consultation menu opens free-form spa questions instead of answering with a fixed card', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-7b',
    from: '56911111111',
    type: 'interactive',
    text: 'Consultas',
    selectedId: 'menu:consult',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /cualquier pregunta sobre el spa/i);
});

test('free-form consultation keeps answering instead of returning to the main menu', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'faq',
      currentStep: 'consultation_open',
      collectedData: null,
      lastBookingId: null
    },
    openAIService: {
      answerFaq: async (text) => `Respuesta libre: ${text}`
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-7c',
    from: '56911111111',
    type: 'text',
    text: 'en que consisten los masajes?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /Respuesta libre:/);
});

test('consultation about services answers conversationally instead of sending the booking list', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'faq',
      currentStep: 'consultation_open',
      collectedData: null,
      lastBookingId: null
    },
    openAIService: {
      answerFaq: async (text) => `Conversacion FAQ: ${text}`
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-7d',
    from: '56911111111',
    type: 'text',
    text: 'que servicios tienen disponibles y de que trata cada uno?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /Conversacion FAQ:/);
});

test('service consultation answer includes buttons for another question and booking', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'faq',
      currentStep: 'faq_context',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null
    },
    openAIService: {
      answerFaq: async () => '✨ Limpieza facial profunda\n⏱️ Duracion: 75 minutos\n💰 Precio: $197 CLP'
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-service-faq-buttons',
    from: '56911111111',
    type: 'text',
    text: 'cual es el valor?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /Precio: \$197 CLP/i);
  assert.match(sentMessages[0].bodyText, /Masaje relajante/i);
  assert.equal(sentMessages[0].buttons[0].id, 'bookservice:svc-1');
  assert.equal(sentMessages[0].buttons[1].id, 'askservice:svc-1');
});

test('consultation switches to guided booking flow when the client asks to reserve', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'faq',
      currentStep: 'consultation_open',
      collectedData: null,
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-7e',
    from: '56911111111',
    type: 'text',
    text: 'quiero reservar',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages[0].kind, 'list');
  assert.match(sentMessages[0].bodyText, /servicio/i);
});

test('duplicate incoming provider ids are ignored and do not send another reply', async () => {
  const sentMessages = [];
  const orchestrator = createChatOrchestrator({
    openAIService: {
      classifyIntent: async () => ({ intent: 'booking', confidence: 0.99, entities: {} }),
      answerFaq: async () => 'faq',
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage,
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        confidence: 0.9
      })
    },
    clientService: {
      findOrCreateByWhatsappNumber: async () => ({ id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: null }),
      updateClient: async () => ({})
    },
    conversationService: {
      getOrCreateActiveConversation: async () => ({
        id: 'conv-1',
        currentIntent: 'unknown',
        currentStep: 'idle',
        collectedData: null,
        lastBookingId: null,
        botPaused: false,
        takenOverByAgent: false
      }),
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
      findUpcomingBookingsForClient: async () => [],
      quoteAvailability: async () => ({}),
      createPendingBooking: async () => ({}),
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
    selectedId: null,
    media: null
  });

  assert.equal(reply.intent, 'duplicate');
  assert.equal(sentMessages.length, 0);
});

test('manual takeover prevents automatic replies while still storing the incoming message', async () => {
  let incomingSaved = 0;
  let touched = 0;
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'faq',
      currentStep: 'manual_control',
      collectedData: { serviceId: 'svc-1' },
      lastBookingId: null,
      botPaused: true,
      takenOverByAgent: true
    },
    conversationService: {
      touchConversation: async () => {
        touched += 1;
      }
    },
    messageService: {
      createIncomingMessage: async () => {
        incomingSaved += 1;
        return {};
      },
      createOutgoingMessage: async () => {
        throw new Error('should not create automatic outgoing messages while paused');
      }
    },
    openAIService: {
      classifyIntent: async () => {
        throw new Error('should not classify messages while paused');
      }
    }
  });

  const reply = await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-paused',
    from: '56911111111',
    type: 'text',
    text: 'Necesito ayuda humana',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(reply.intent, 'agent_controlled');
  assert.equal(incomingSaved, 1);
  assert.equal(touched, 1);
  assert.equal(sentMessages.length, 0);
});

test('stale manual takeover is auto-resumed and the bot replies again', async () => {
  let resumed = 0;
  const { orchestrator, sentMessages, conversation } = createDependencies({
    conversation: {
      id: 'conv-1',
      currentIntent: 'unknown',
      currentStep: 'idle',
      collectedData: null,
      lastBookingId: null,
      botPaused: true,
      takenOverByAgent: true,
      takenOverAt: '2026-04-20T10:00:00.000Z'
    },
    conversationService: {
      shouldAutoResume: () => true,
      resumeBotConversation: async () => {
        resumed += 1;
        return Object.assign(conversation, {
          botPaused: false,
          takenOverByAgent: false,
          takenOverAt: null,
          takenOverByUserId: null
        });
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-auto-resume',
    from: '56911111111',
    type: 'text',
    text: 'hola',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(resumed, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(conversation.botPaused, false);
  assert.equal(conversation.takenOverByAgent, false);
});

test('manage reservations flow opens a safe management menu instead of cancelling directly', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'menu',
      currentStep: 'main_menu',
      collectedData: null,
      lastBookingId: null
    },
    bookingService: {
      findUpcomingBookingsForClient: async () => ([
        {
          id: 'booking-1',
          scheduledAt: '2026-04-15T10:00:00.000Z',
          service: { name: 'Masaje relajante' }
        },
        {
          id: 'booking-2',
          scheduledAt: '2026-04-16T12:00:00.000Z',
          service: { name: 'Limpieza facial profunda' }
        }
      ])
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-manage',
    from: '56911111111',
    type: 'interactive',
    text: 'Gestionar reservas',
    selectedId: 'menu:manage',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /2 reservas activas/i);
  assert.equal(sentMessages[0].buttons[0].id, 'manage:view');
  assert.equal(sentMessages[0].buttons[1].id, 'manage:cancel');
});

test('view reservations shows upcoming bookings without entering cancellation flow', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'manage_bookings',
      currentStep: 'manage_bookings_menu',
      collectedData: null,
      lastBookingId: null
    },
    bookingService: {
      findUpcomingBookingsForClient: async () => ([
        {
          id: 'booking-1',
          scheduledAt: '2026-04-15T10:00:00.000Z',
          service: { name: 'Masaje relajante' }
        },
        {
          id: 'booking-2',
          scheduledAt: '2026-04-16T12:00:00.000Z',
          service: { name: 'Limpieza facial profunda' }
        }
      ])
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-manage-view',
    from: '56911111111',
    type: 'interactive',
    text: 'Ver reservas',
    selectedId: 'manage:view',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /Estas son sus proximas reservas/i);
  assert.match(sentMessages[0].bodyText, /Masaje relajante/i);
  assert.match(sentMessages[0].bodyText, /Limpieza facial profunda/i);
});

test('booking status question answers with the next reservation instead of sending the main menu', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    bookingService: {
      findUpcomingBookingsForClient: async () => ([
        {
          id: 'booking-1',
          scheduledAt: '2026-04-30T22:00:00.000Z',
          service: { name: 'Masaje relajante' }
        }
      ])
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-booking-status',
    from: '56911111111',
    type: 'text',
    text: 'me olvide de que hora era, me la dices',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /Su proxima reserva/i);
  assert.match(sentMessages[0].bodyText, /Masaje relajante/i);
  assert.match(sentMessages[0].bodyText, /2026-04-30 18:00/);
  assert.doesNotMatch(sentMessages[0].bodyText, /menu principal/i);
});

test('booking status question without reservations offers management alternatives', async () => {
  const { orchestrator, sentMessages } = createDependencies();

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-booking-status-empty',
    from: '56911111111',
    type: 'text',
    text: 'tengo alguna reserva?',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: null
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /No hay reservas activas para mostrar/i);
  assert.equal(sentMessages[0].buttons[0].id, 'menu:book');
});

test('proof image accepts a different payer when the destination account is trusted', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonzalo Benjamin Enrique Garrote Perez',
        payerFormalId: null,
        payerAccountNumber: '19841193252',
        recipientName: 'Gonzalo benjamín enrique',
        recipientFormalId: null,
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        transactionId: '156387031993',
        confidence: 0.9
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-name',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-name',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image with missing payer name is accepted when the destination account is trusted', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-30T20:00:00.000Z',
        holdExpiresAt: '2026-04-30T22:30:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: null,
        payerFormalId: null,
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-30T17:11:00-04:00',
        transactionId: '156387031993',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-missing-name',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-missing-name',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image accepts payer RUT even when payer name is missing', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-05-04', time: '00:30' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-05-04T04:40:00.000Z',
        holdExpiresAt: '2026-05-04T05:10:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: null,
        payerFormalId: '000210931468',
        recipientName: 'Gonzalo Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-05-04T00:55:40-04:00',
        transactionId: '8087754',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-missing-name-rut-only',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-missing-name-rut-only',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image accepts payer origin account when it matches the expected RUT with leading zeros', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Juanito', lastName: 'Perez', formalId: '12-3' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-05-04', time: '00:30' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-05-04T04:40:00.000Z',
        holdExpiresAt: '2026-05-04T05:10:00.000Z',
        payerFormalId: '12-3',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Juanito', lastName: 'Perez', formalId: '12-3' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: null,
        payerFormalId: null,
        payerAccountNumber: '000123',
        recipientName: 'Gonzalo Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-05-04T00:55:40-04:00',
        transactionId: '8087755',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-origin-account-rut',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Juanito',
    media: {
      id: 'media-proof-origin-account-rut',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image is rejected when the destination account does not match the spa transfer account', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 300,
        payerName: 'Gonzalo Benjamin Enrique Garrote Perez',
        payerFormalId: '21093146-8',
        recipientName: 'Gonzalo Garrote',
        recipientFormalId: null,
        recipientAccountNumber: '19841193252',
        recipientBank: 'Banco Falabella',
        paymentTimestamp: '2026-04-30T17:11:00-04:00',
        transactionId: '156387031993',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-wrong-destination',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-wrong-destination',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /cuenta destino del comprobante no coincide/i);
});

test('proof image accepts recipient name and account when recipient RUT is missing', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-05-04', time: '00:30' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-05-04T04:40:00.000Z',
        holdExpiresAt: '2026-05-04T05:10:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '21093146-8',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: null,
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-05-04T00:55:40-04:00',
        transactionId: '8003257',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-recipient-rut-missing',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-recipient-rut-missing',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image rejects when destination account data is incomplete even if recipient RUT matches', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-30T20:00:00.000Z',
        holdExpiresAt: '2026-04-30T22:30:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientFormalId: '210931465',
        recipientBank: 'Banco Falabella',
        paymentTimestamp: '2026-04-30T17:11:00-04:00',
        transactionId: '156387031993',
        confidence: 0.97
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-bank-diff-rut-match',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-bank-diff-rut-match',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /cuenta destino del comprobante no coincide/i);
});

test('proof image accepts recipient alias name under strict validation', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonzalo Benjamin', lastName: 'Enrique Garrote Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-30', time: '18:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-05-01T00:10:00.000Z',
        holdExpiresAt: '2026-05-01T00:20:00.000Z',
        service: { name: 'Masaje de Espalda', currency: 'CLP' },
        client: { name: 'Gonzalo Benjamin', lastName: 'Enrique Garrote Perez', formalId: '210931468' }
      }),
      confirmPendingBooking: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        scheduledAt: '2026-04-30T22:00:00.000Z',
        service: { name: 'Masaje de Espalda', currency: 'CLP' }
      })
    },
    openAIService: {
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage,
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonzalo Benjamin Enrique Garrote Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-30T20:11:52-04:00',
        transactionId: '955665533309',
        confidence: 0.98
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-truncated-recipient',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-truncated-recipient',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
});

test('proof image is rejected when payment time is outside the allowed hold window', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:25:00-03:00',
        transactionId: '156387031993',
        confidence: 0.9
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-time',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-time',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /hora del pago no coincide/i);
});

test('proof image accepts receipts without visible RUT when amount, name and time are consistent', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-15T12:00:00.000Z',
        holdExpiresAt: '2026-04-15T12:10:00.000Z',
        service: { name: 'Masaje relajante', currency: 'CLP' },
        client: { name: 'Gonza Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: true,
        reason: 'ok',
        detectedAmount: 100,
        payerName: 'Gonza Benjamin Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        transactionId: '156387031993',
        confidence: 0.9
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-duplicate-name',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-duplicate-name',
      mimeType: 'image/png',
      caption: ''
    }
  });

    assert.equal(sentMessages[0].kind, 'buttons');
    assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
  });

test('proof image with lower amount offers partial payment options instead of rejecting the receipt', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 10000,
        createdAt: '2026-04-15T12:00:00.000Z',
        holdExpiresAt: '2026-04-15T12:10:00.000Z',
        service: { name: 'Limpieza facial profunda', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      })
    },
    openAIService: {
      validatePaymentProof: async () => ({
        isValid: false,
        reason: 'El monto no coincide, pero el comprobante parece autentico.',
        detectedAmount: 4300,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        transactionId: 'tx-4300',
        confidence: 0.92
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-partial',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-partial',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /Recibimos su comprobante por 4300 CLP/i);
  assert.match(sentMessages[0].text, /Le faltan 5700 CLP/i);
  assert.match(sentMessages[0].text, /Transferir los 5700 CLP restantes/i);
  assert.equal(conversation.currentStep, 'awaiting_partial_supplement');
  assert.equal(conversation.collectedData.partialAmountPaid, 4300);
});

test('proof image with higher amount confirms booking and explains the extra credit', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '11:30' },
      lastBookingId: 'booking-1'
    },
    bookingService: {
      recordPaymentProofSubmission: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        createdAt: '2026-04-15T12:00:00.000Z',
        holdExpiresAt: '2026-04-15T12:10:00.000Z',
        service: { name: 'Limpieza facial profunda', currency: 'CLP' },
        client: { name: 'Gonza', lastName: 'Perez', formalId: '210931468' }
      }),
      confirmPendingBooking: async () => ({
        id: 'booking-1',
        depositAmount: 100,
        scheduledAt: '2026-04-15T14:30:00.000Z',
        service: { name: 'Limpieza facial profunda', currency: 'CLP' }
      })
    },
    openAIService: {
      craftBookingReply: async ({ fallbackMessage }) => fallbackMessage,
      validatePaymentProof: async () => ({
        isValid: false,
        reason: 'El monto es mayor al requerido, pero el comprobante parece autentico.',
        detectedAmount: 150,
        payerName: 'Gonza Perez',
        payerFormalId: '210931468',
        recipientName: 'Gonzalo Benjamin Enrique Garrote Perez',
        recipientFormalId: '210931465',
        recipientAccountNumber: '1020190317',
        recipientBank: 'Mercado Pago',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
        transactionId: 'tx-150',
        confidence: 0.94
      })
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-proof-overpay',
    from: '56911111111',
    type: 'image',
    text: '',
    selectedId: null,
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    media: {
      id: 'media-proof-overpay',
      mimeType: 'image/png',
      caption: ''
    }
  });

  assert.equal(sentMessages[0].kind, 'buttons');
  assert.match(sentMessages[0].bodyText, /quedo confirmada/i);
  assert.match(sentMessages[0].bodyText, /abono 150 CLP/i);
  assert.match(sentMessages[0].bodyText, /descontaremos los 50 CLP adicionales/i);
});

test('campaign price question responds with base price, benefit and final price', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-campaign-price',
      currentIntent: 'campaign',
      currentStep: 'answered',
      collectedData: {
        campaignContext: {
          source: 'campaign',
          campaignId: 'camp-1',
          offerId: 'offer-1',
          campaignRecipientId: 'recipient-1',
          serviceId: 'svc-1'
        }
      },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-campaign-price',
    from: '56911111111',
    type: 'text',
    text: 'cuanto sale la promo?',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages.at(-1).kind, 'text');
  assert.match(sentMessages.at(-1).text, /precio base/i);
  assert.match(sentMessages.at(-1).text, /20% de descuento/i);
  assert.match(sentMessages.at(-1).text, /\$28\.000 CLP/i);
});

test('campaign opt-out updates client preference and clears campaign context', async () => {
  let optedOutRecipientId = null;
  const { orchestrator, conversation, client, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-campaign-optout',
      currentIntent: 'campaign',
      currentStep: 'answered',
      collectedData: {
        campaignContext: {
          source: 'campaign',
          campaignId: 'camp-1',
          offerId: 'offer-1',
          campaignRecipientId: 'recipient-1',
          serviceId: 'svc-1'
        }
      },
      lastBookingId: null
    },
    campaignService: {
      markRecipientOptedOut: async (recipientId) => {
        optedOutRecipientId = recipientId;
      }
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-campaign-optout',
    from: '56911111111',
    type: 'text',
    text: 'stop',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(client.marketingOptOut, true);
  assert.equal(optedOutRecipientId, 'recipient-1');
  assert.equal(conversation.collectedData?.campaignContext, undefined);
  assert.equal(sentMessages.at(-1).kind, 'text');
  assert.match(sentMessages.at(-1).text, /no volvera a recibir promociones/i);
});

test('campaign booking intent first shows the offer summary before the reservation flow', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-campaign-booking',
      currentIntent: 'campaign',
      currentStep: 'answered',
      collectedData: {
        campaignContext: {
          source: 'campaign',
          campaignId: 'camp-1',
          offerId: 'offer-1',
          campaignRecipientId: 'recipient-1',
          serviceId: 'svc-1'
        }
      },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-campaign-booking',
    from: '56911111111',
    type: 'text',
    text: 'quiero reservar',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages.at(-1).kind, 'buttons');
  assert.match(sentMessages.at(-1).bodyText, /abono habitual/i);
  assert.match(sentMessages.at(-1).bodyText, /Quieres continuar con la reserva/i);
});

test('campaign quick reply button text "Reservar" also opens the offer intro', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    conversation: {
      id: 'conv-campaign-button-booking',
      currentIntent: 'campaign',
      currentStep: 'answered',
      collectedData: {
        campaignContext: {
          source: 'campaign',
          campaignId: 'camp-1',
          offerId: 'offer-1',
          campaignRecipientId: 'recipient-1',
          serviceId: 'svc-1'
        }
      },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-campaign-button-booking',
    from: '56911111111',
    type: 'button',
    text: 'Reservar',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(sentMessages.at(-1).kind, 'buttons');
  assert.match(sentMessages.at(-1).bodyText, /que bueno que quieres aprovechar la promo/i);
  assert.match(sentMessages.at(-1).bodyText, /Quieres continuar con la reserva/i);
});

test('campaign booking confirmation continues into the reservation flow instead of repeating the promo intro', async () => {
  const { orchestrator, sentMessages, conversation } = createDependencies({
    conversation: {
      id: 'conv-campaign-booking-confirm',
      currentIntent: 'campaign',
      currentStep: 'campaign_booking_intro',
      collectedData: {
        campaignContext: {
          source: 'campaign',
          campaignId: 'camp-1',
          offerId: 'offer-1',
          campaignRecipientId: 'recipient-1',
          serviceId: 'svc-1'
        }
      },
      lastBookingId: null
    }
  });

  await orchestrator.handleIncomingMessage({
    providerMessageId: 'wamid-campaign-booking-confirm',
    from: '56911111111',
    type: 'text',
    text: 'si, quiero seguir',
    timestamp: String(Date.now()),
    profileName: 'Gonza',
    selectedId: null,
    media: null
  });

  assert.equal(conversation.currentStep, 'awaiting_formal_id');
  assert.equal(sentMessages.at(-1).kind, 'text');
  assert.match(sentMessages.at(-1).text, /RUT o identificador/i);
});
