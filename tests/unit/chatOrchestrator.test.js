const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatOrchestrator } = require('../../src/services/chatOrchestrator');

function createDependencies(overrides = {}) {
  const sentMessages = [];
  const client = overrides.client || { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: null };
  const conversation = overrides.conversation || { id: 'conv-1', currentIntent: 'unknown', currentStep: 'idle', collectedData: null, lastBookingId: null };

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
      ...(overrides.conversationService || {})
    },
    messageService: {
      findIncomingByProviderId: async () => null,
      createIncomingMessage: async () => ({}),
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
    }
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

test('valid proof image confirms the booking after payment validation', async () => {
  const { orchestrator, sentMessages } = createDependencies({
    client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
    conversation: {
      id: 'conv-1',
      currentIntent: 'booking',
      currentStep: 'awaiting_payment_proof',
      collectedData: { bookingId: 'booking-1', serviceId: 'svc-1', date: '2026-04-15', time: '10:00' },
      lastBookingId: 'booking-1'
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

test('proof image is rejected when the payer name does not match the reservation data', async () => {
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
        payerName: 'Otra Persona',
        payerFormalId: '210931468',
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
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

  assert.equal(sentMessages[0].kind, 'text');
  assert.match(sentMessages[0].text, /nombre del comprobante no coincide/i);
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
        paymentTimestamp: '2026-04-15T09:25:00-03:00',
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
        payerFormalId: null,
        paymentTimestamp: '2026-04-15T09:05:00-03:00',
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
