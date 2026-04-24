const dayjs = require('dayjs');

const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');
const { createBookingFlow } = require('../flows/booking.flow');
const { createFaqFlow } = require('../flows/faq.flow');
const {
  asksForBusinessInfo,
  asksForTimeRemaining,
  buildReply,
  inferDeterministicIntent,
  inferPaymentMethod,
  looksLikeDate,
  looksLikeEmail,
  looksLikeFormalId,
  looksLikeName,
  looksLikeTime,
  normalizeCollectedData,
  parseSelectedAction,
  resolveServiceSelection,
  wantsMainMenu
} = require('../flows/helpers');
const { createServicesFlow } = require('../flows/services.flow');
const { createWelcomeFlow } = require('../flows/welcome.flow');

function createChatOrchestrator({
  openAIService,
  clientService,
  conversationService,
  messageService,
  bookingService,
  serviceCatalogService,
  metaClient,
  chatwootService,
  mediaService
}) {
  const welcomeFlow = createWelcomeFlow();
  const servicesFlow = createServicesFlow({ serviceCatalogService });
  const faqFlow = createFaqFlow({ openAIService, serviceCatalogService });
  const bookingFlow = createBookingFlow({
    bookingService,
    servicesFlow
  });

  async function handleIncomingMessage(message) {
    const existingIncomingMessage = await messageService.findIncomingByProviderId(message.providerMessageId);
    if (existingIncomingMessage) {
      return buildReply({
        intent: 'duplicate',
        step: 'ignored_duplicate',
        text: 'Evento duplicado ignorado.',
        collectedData: {}
      });
    }

    const client = await clientService.findOrCreateByWhatsappNumber({
      whatsappNumber: message.from,
      name: message.profileName
    });
    let conversation = await conversationService.getOrCreateActiveConversation(client.id);

    const createdIncomingMessage = await messageService.createIncomingMessage({
      conversationId: conversation.id,
      clientId: client.id,
      content: message.text || message.selectedId || message.media?.caption || '',
      providerId: message.providerMessageId,
      messageType: message.type,
      metadata: {
        timestamp: message.timestamp,
        type: message.type,
        selectedId: message.selectedId || null,
        media: message.media || null
      }
    });

    if (message.media?.id && mediaService?.persistIncomingMedia) {
      try {
        await mediaService.persistIncomingMedia({
          messageRecord: createdIncomingMessage,
          media: message.media
        });
      } catch (error) {
        logger.error('Media persistence failed for incoming message', {
          conversationId: conversation.id,
          clientId: client.id,
          providerMessageId: message.providerMessageId,
          mediaId: message.media.id,
          error: error.message
        });
      }
    }

    if (conversationService.isBotPaused?.(conversation) && conversationService.shouldAutoResume?.(conversation)) {
      conversation = await conversationService.resumeBotConversation(conversation.id);
      logger.warn('Auto-resumed stale manual control conversation', {
        conversationId: conversation.id,
        clientId: client.id,
        takenOverAt: conversation.takenOverAt || null
      });
    }

    if (conversationService.isBotPaused?.(conversation)) {
      await conversationService.touchConversation?.(conversation.id);
      logger.info('Bot reply skipped because conversation is under manual control', {
        conversationId: conversation.id,
        clientId: client.id,
        botPaused: Boolean(conversation.botPaused),
        takenOverByAgent: Boolean(conversation.takenOverByAgent)
      });

      return buildReply({
        intent: 'agent_controlled',
        step: conversation.currentStep || 'manual_control',
        text: 'Conversacion en control manual.',
        collectedData: conversation.collectedData || {}
      });
    }

    if (chatwootService) {
      try {
        await chatwootService.captureIncomingMessage({
          client,
          conversation,
          message
        });
      } catch (error) {
        logger.error('Chatwoot sync failed for incoming message', {
          conversationId: conversation.id,
          clientId: client.id,
          providerMessageId: message.providerMessageId,
          error: error.message
        });
      }
    }

    let reply;

    try {
      const intentResult = await openAIService.classifyIntent(message.text || message.selectedId || '');
      reply = await routeConversation({
        client,
        conversation,
        message,
        intentResult
      });
    } catch (error) {
      reply = buildReply({
        intent: 'error',
        step: conversation.currentStep || 'error',
        text: buildUserFacingErrorMessage(error),
        collectedData: conversation.collectedData || {}
      });
    }

    await messageService.createOutgoingMessage({
      conversationId: conversation.id,
      clientId: client.id,
      content: reply.text,
      metadata: {
        intent: reply.intent,
        step: reply.step,
        messageType: reply.outbound?.kind || 'text'
      }
    });

    await conversationService.updateConversation(conversation.id, {
      currentIntent: reply.intent,
      currentStep: reply.step,
      collectedData: preserveSystemCollectedData(
        conversation.collectedData,
        reply.collectedData || conversation.collectedData || undefined
      ),
      lastBookingId: reply.lastBookingId || conversation.lastBookingId || undefined
    });

    try {
      await sendReply(metaClient, client.whatsappNumber, reply);
    } catch (_error) {
      return reply;
    }

    return reply;
  }

  async function routeConversation({ client, conversation, message, intentResult }) {
    const text = message.text || '';
    const lowerText = String(text || '').toLowerCase();
    const collectedData = normalizeCollectedData(conversation.collectedData);
    const selectedAction = parseSelectedAction(message.selectedId);
    const matchedService = await resolveServiceSelection({ selectedAction, text, serviceCatalogService });
    const deterministicIntent = inferDeterministicIntent(lowerText, matchedService, selectedAction);
    const resolvedIntent = deterministicIntent || intentResult.intent;
    const paymentMethod = inferPaymentMethod(text, selectedAction);

    if (wantsMainMenu(lowerText) || (selectedAction?.type === 'menu' && selectedAction.value === 'main')) {
      return welcomeFlow.buildMainMenuReply();
    }

    if (selectedAction?.type === 'faq') {
      return faqFlow.buildFaqReply(selectedAction.value, collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'book') {
      return bookingFlow.startBookingFlow(client, {});
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'services') {
      return servicesFlow.buildServiceListReply(collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'consult') {
      return faqFlow.buildConsultationWelcomeReply(collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'manage') {
      logger.info('Opening manage bookings menu', {
        clientId: client.id,
        whatsappNumber: client.whatsappNumber
      });
      return handleManageBookingsMenu(client.id);
    }

    if (selectedAction?.type === 'manage' && selectedAction.value === 'view') {
      logger.info('Viewing upcoming bookings', {
        clientId: client.id,
        whatsappNumber: client.whatsappNumber
      });
      return handleViewBookingsIntent(client.id);
    }

    if (selectedAction?.type === 'manage' && selectedAction.value === 'cancel') {
      logger.info('Entering cancellation selection flow', {
        clientId: client.id,
        whatsappNumber: client.whatsappNumber
      });
      return handleCancelBookingIntent(client.id);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'exit') {
      return buildReply({
        intent: 'exit',
        step: 'main_menu',
        text: '🌿 Gracias por escribirnos.\n\nCuando quiera volver, aqui estare para ayudarle.',
        collectedData: {}
      });
    }

    if (selectedAction?.type === 'cancelbooking') {
      logger.info('Selected booking for cancellation review', {
        clientId: client.id,
        whatsappNumber: client.whatsappNumber,
        bookingId: selectedAction.value
      });
      const upcomingBookings = await bookingService.findUpcomingBookingsForClient(client.id, { limit: 10 });
      const selectedBooking = upcomingBookings.find((booking) => booking.id === selectedAction.value);

      if (!selectedBooking) {
        return buildReply({
          intent: 'cancel_booking',
          step: 'cancel_booking_missing',
          text: 'No encontre una reserva activa con esa opcion.\n\nSi quiere, puedo mostrarle sus proximas citas.',
          collectedData
        });
      }

      return buildReply({
        intent: 'cancel_booking',
        step: 'awaiting_cancel_confirmation',
        text: `⚠️ Esta a punto de cancelar su cita.\n\nServicio: ${selectedBooking.service.name}\nFecha: ${dayjs(selectedBooking.scheduledAt).format('YYYY-MM-DD HH:mm')}\n\n¿Desea confirmar la cancelacion?`,
        collectedData,
        outbound: {
          kind: 'buttons',
          bodyText: `⚠️ Confirmar cancelacion de ${selectedBooking.service.name}\n${dayjs(selectedBooking.scheduledAt).format('YYYY-MM-DD HH:mm')}`,
          buttons: [
            { id: `cancelconfirm:${selectedBooking.id}`, title: 'Si, cancelar' },
            { id: 'menu:main', title: 'Volver' }
          ]
        }
      });
    }

    if (selectedAction?.type === 'cancelconfirm') {
      logger.warn('Confirmed booking cancellation from chat flow', {
        clientId: client.id,
        whatsappNumber: client.whatsappNumber,
        bookingId: selectedAction.value
      });
      const cancelledBooking = await bookingService.cancelBooking(selectedAction.value);

      const wasPaid = cancelledBooking.paymentStatus === 'APPROVED';
      const baseText = `✅ Su cita de ${cancelledBooking.service.name} para el ${dayjs(cancelledBooking.scheduledAt).format('YYYY-MM-DD HH:mm')} fue cancelada correctamente.`;
      const refundNote = wasPaid
        ? `\n\nComo ya habia realizado un abono para esta reserva, el equipo del spa se pondra en contacto con usted a la brevedad para solicitar sus datos bancarios y gestionar la devolucion del monto abonado.`
        : '';

      return buildReply({
        intent: 'cancel_booking',
        step: 'cancelled',
        text: `${baseText}${refundNote}`,
        collectedData: {}
      });
    }

    if (message.media && ['awaiting_payment_proof', 'payment_proof_rejected_retry', 'awaiting_partial_supplement'].includes(conversation.currentStep)) {
      return handlePaymentProofSubmission({
        client,
        conversation,
        message,
        collectedData
      });
    }

    if (!text && !message.selectedId && !message.media) {
      return welcomeFlow.buildMainMenuReply();
    }

    // Si el usuario ya esta en flujo de reserva y elige un servicio, debe continuar la reserva
    // en lugar de volver al detalle informativo del servicio.
    if ((matchedService || selectedAction?.type === 'service') && conversation.currentStep === 'awaiting_service') {
      if (!matchedService) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_service',
          text: '🗓️ Elija uno de nuestros servicios para continuar con la reserva.',
          collectedData,
          outbound: await servicesFlow.createServiceListOutbound()
        });
      }

      return bookingFlow.buildServiceSelectionReply(client, matchedService, collectedData);
    }

    // Seleccion de servicio para modo catalogo / consultas
    if (matchedService || selectedAction?.type === 'service') {
      if (!matchedService) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_service',
          text: '💆 Elija uno de nuestros servicios para ver su detalle.',
          collectedData,
          outbound: await servicesFlow.createServiceListOutbound()
        });
      }
      return servicesFlow.buildServiceDetailReply(matchedService, collectedData);
    }

    // Cliente presiono "Reservar" desde el detalle del servicio
    if (selectedAction?.type === 'bookservice') {
      const serviceToBook = await serviceCatalogService.getServiceById(selectedAction.value).catch(() => null);
      if (serviceToBook) {
        return bookingFlow.buildServiceSelectionReply(client, serviceToBook, collectedData);
      }
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: '😅 No encontre ese servicio.\n\nPor favor elija uno de la lista.',
        collectedData,
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    // Cliente presiono "Consultas" desde el detalle del servicio → modo FAQ con contexto
    if (selectedAction?.type === 'askservice') {
      const serviceToAsk = await serviceCatalogService.getServiceById(selectedAction.value).catch(() => null);
      const serviceName = serviceToAsk?.name || 'ese servicio';
      return buildReply({
        intent: 'faq',
        step: 'faq_context',
        text: `💬 Claro.\n\n¿Que desea saber sobre ${serviceName}?\nPuede escribirme su duda y con gusto le respondo.`,
        collectedData: {
          ...collectedData,
          serviceId: selectedAction.value
        }
      });
    }

    if (resolvedIntent === 'manage_bookings') {
      return handleBookingStatusIntent(client.id);
    }

    if (resolvedIntent === 'booking' && canStartBookingFromContext(conversation.currentStep)) {
      return bookingFlow.startBookingFlow(client, collectedData);
    }

    // Consulta de tiempo restante para el pago
    const paymentSteps = ['awaiting_payment_proof', 'awaiting_partial_supplement', 'payment_proof_rejected_retry'];
    if (paymentSteps.includes(conversation.currentStep) && text && asksForTimeRemaining(lowerText)) {
      const bookingId = conversation.lastBookingId || collectedData.bookingId;
      if (bookingId) {
        const holdBooking = await bookingService.getBookingById(bookingId).catch(() => null);
        if (holdBooking && holdBooking.holdExpiresAt) {
          const minutesLeft = Math.ceil(dayjs(holdBooking.holdExpiresAt).diff(dayjs(), 'second') / 60);
          if (minutesLeft <= 0) {
            return buildReply({
              intent: 'booking',
              step: 'main_menu',
              text: '⌛ Su tiempo para confirmar la cita ya expiro y el horario fue liberado.\n\nEscriba "menu" para volver al menu principal y realizar una nueva reserva.',
              collectedData: {}
            });
          }
          const minuteWord = minutesLeft === 1 ? 'minuto' : 'minutos';
          return buildReply({
            intent: 'booking',
            step: conversation.currentStep,
            text: `⏳ Le quedan aproximadamente ${minutesLeft} ${minuteWord} para enviar su comprobante y confirmar su cita.`,
            collectedData,
            lastBookingId: bookingId
          });
        }
      }
    }

    // Catch-all: cualquier mensaje de texto durante un paso de pago no debe salir del contexto.
    // En lugar de caer al menu principal, recordar al cliente que envie el comprobante.
    if (paymentSteps.includes(conversation.currentStep) && text) {
      return buildReply({
        intent: 'booking',
        step: conversation.currentStep,
        text: '⏳ Su reserva sigue activa.\n\nCuando realice el pago, envie aqui una foto o captura del comprobante para confirmarlo.\n\nSi quiere saber cuanto tiempo le queda, escriba "cuanto tiempo me queda".',
        collectedData,
        lastBookingId: conversation.lastBookingId || collectedData.bookingId || null
      });
    }

    if (conversation.currentStep === 'awaiting_name' && looksLikeName(text)) {
      const fullName = splitFullName(text);
      if (!fullName) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_name',
          text: '👤 Para continuar con la reserva, necesito su nombre y apellidos completos.',
          collectedData
        });
      }

      await clientService.updateClient(client.id, fullName);

      if (!client.formalId) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_formal_id',
          text: '🪪 Perfecto.\n\nAhora necesito su RUT o identificador antes de mostrarle fechas disponibles.',
          collectedData
        });
      }

      if (collectedData.date && collectedData.time) {
        return bookingFlow.buildPayerRoleReply({
          ...client,
          ...fullName
        }, collectedData);
      }

      return bookingFlow.buildDatePrompt(collectedData);
    }

    if (conversation.currentStep === 'awaiting_last_name' && looksLikeName(text)) {
      await clientService.updateClient(client.id, { lastName: text.trim() });

      if (!client.formalId) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_formal_id',
          text: '🪪 Perfecto.\n\nAhora necesito su RUT o identificador antes de mostrarle fechas disponibles.',
          collectedData
        });
      }

      return bookingFlow.buildDatePrompt(collectedData);
    }

    if (conversation.currentStep === 'awaiting_formal_id' && looksLikeFormalId(text)) {
      await clientService.updateClient(client.id, { formalId: text.trim() });
      if (collectedData.date && collectedData.time) {
        return bookingFlow.buildPayerRoleReply({
          ...client,
          formalId: text.trim()
        }, collectedData);
      }

      return bookingFlow.buildDatePrompt(collectedData);
    }

    if (conversation.currentStep === 'editing_payer_name' && looksLikeName(text)) {
      const fullName = splitFullName(text);
      if (!fullName) {
        return buildReply({
          intent: 'booking',
          step: 'editing_payer_name',
          text: '👤 Necesito su nombre y apellidos completos para actualizar el registro.',
          collectedData
        });
      }

      await clientService.updateClient(client.id, fullName);
      return buildReply({
        intent: 'booking',
        step: 'editing_payer_formal_id',
        text: '✅ Nombre actualizado.\n\nAhora indique su RUT o identificador para corregirlo.',
        collectedData: {
          ...collectedData,
          payerName: fullName.name,
          payerLastName: fullName.lastName
        }
      });
    }

    if (conversation.currentStep === 'editing_payer_formal_id' && looksLikeFormalId(text)) {
      await clientService.updateClient(client.id, { formalId: text.trim() });
      const updatedClient = { ...client, ...splitFullName([collectedData.payerName, collectedData.payerLastName].filter(Boolean).join(' ')) || {}, formalId: text.trim() };
      return bookingFlow.buildPayerSummaryReply(updatedClient, collectedData);
    }

    if (['awaiting_payer_role', 'awaiting_payer_confirmation'].includes(conversation.currentStep)) {
      if (selectedAction?.type === 'payer' && selectedAction.value === 'self') {
        return bookingFlow.buildPayerSummaryReply(client, collectedData);
      }

      if (selectedAction?.type === 'payer' && selectedAction.value === 'other') {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_payer_name',
          text: '👤 Perfecto.\n\nIndique el nombre y apellidos de la persona que realizara el pago.',
          collectedData: {
            ...collectedData,
            payerName: null,
            payerLastName: null,
            payerFormalId: null,
            payerEmail: null
          }
        });
      }
    }

    if (conversation.currentStep === 'awaiting_payer_confirmation' && selectedAction?.type === 'payerconfirm' && selectedAction.value === 'self') {
      return bookingFlow.buildPaymentMethodReply(collectedData);
    }

    if (['awaiting_payer_role', 'awaiting_payer_confirmation'].includes(conversation.currentStep) && selectedAction?.type === 'payeredit' && selectedAction.value === 'self') {
      return buildReply({
        intent: 'booking',
        step: 'editing_payer_name',
        text: '👤 Entendido.\n\nIndique su nombre y apellidos completos para actualizarlos.',
        collectedData
      });
    }

    if (conversation.currentStep === 'awaiting_payer_name' && looksLikeName(text)) {
      const fullName = splitFullName(text);
      if (!fullName) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_payer_name',
          text: '👤 Necesito el nombre y apellidos completos de la persona que realizara el pago.',
          collectedData
        });
      }

      return buildReply({
        intent: 'booking',
        step: 'awaiting_payer_formal_id',
        text: '🪪 Gracias.\n\nAhora indique el RUT o identificador de la persona que realizara el pago.',
        collectedData: {
          ...collectedData,
          payerName: fullName.name,
          payerLastName: fullName.lastName
        }
      });
    }

    if (conversation.currentStep === 'awaiting_payer_formal_id' && looksLikeFormalId(text)) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_payer_email',
        text: '📧 Perfecto.\n\nAhora necesito el correo electronico de la persona que realizara el pago.',
        collectedData: {
          ...collectedData,
          payerFormalId: text.trim()
        }
      });
    }

    if (conversation.currentStep === 'awaiting_payer_email' && looksLikeEmail(text)) {
      return bookingFlow.buildPaymentMethodReply({
        ...collectedData,
        payerEmail: text.trim().toLowerCase()
      });
    }

    if (conversation.currentStep === 'awaiting_payment_method' && paymentMethod) {
      return bookingFlow.initiatePaymentCollection({
        client,
        collectedData,
        paymentMethod
      });
    }

    if (['awaiting_payment_proof', 'payment_proof_rejected_retry'].includes(conversation.currentStep)) {
      return buildReply({
        intent: 'booking',
        step: conversation.currentStep,
        text: '📸 Para validar el abono, necesito que envie una foto o captura del comprobante dentro del tiempo indicado.',
        collectedData,
        lastBookingId: conversation.lastBookingId || collectedData.bookingId || null
      });
    }

    // Fallback: si el paso es awaiting_service y no hay servicio reconocido, mostrar lista
    if (conversation.currentStep === 'awaiting_service') {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: '🗓️ Elija uno de nuestros servicios para continuar con la reserva.',
        collectedData,
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    if (selectedAction?.type === 'slot') {
      return bookingFlow.confirmBookingTime({
        client,
        collectedData,
        selectedValue: selectedAction.value
      });
    }

    if (selectedAction?.type === 'date') {
      return bookingFlow.buildDateReply({
        serviceId: collectedData.serviceId,
        text: selectedAction.value,
        collectedData
      });
    }

    if (conversation.currentStep === 'awaiting_time' || looksLikeTime(lowerText)) {
      return bookingFlow.confirmBookingTime({
        client,
        collectedData,
        selectedValue: text.trim()
      });
    }

    if (conversation.currentStep === 'awaiting_date' || looksLikeDate(lowerText)) {
      return bookingFlow.buildDateReply({
        serviceId: collectedData.serviceId,
        text,
        collectedData
      });
    }

    if (asksForBusinessInfo(lowerText)) {
      return faqFlow.answerQuestion(text, collectedData);
    }

    if (conversation.currentIntent === 'faq' && text) {
      return faqFlow.answerQuestion(text, collectedData);
    }

    if (resolvedIntent === 'faq') {
      return faqFlow.answerQuestion(text, collectedData);
    }

    if (resolvedIntent === 'cancel_booking') {
      return handleCancelBookingIntent(client.id);
    }

    return welcomeFlow.buildMainMenuReply();
  }

  async function handlePaymentProofSubmission({ client, conversation, message, collectedData }) {
    const bookingId = conversation.lastBookingId || collectedData.bookingId;
    if (!bookingId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: 'No encuentro una reserva temporal activa para validar el pago.\n\nPartamos nuevamente seleccionando un servicio.',
        collectedData: {},
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const downloadedMedia = await metaClient.downloadMedia(message.media.id);
    const proofMetadata = {
      providerMessageId: message.providerMessageId,
      mimeType: downloadedMedia.mimeType,
      sizeBytes: downloadedMedia.buffer.length,
      mediaId: message.media.id,
      caption: message.media.caption || ''
    };
    const booking = await bookingService.recordPaymentProofSubmission(bookingId, proofMetadata);
    const validation = await openAIService.validatePaymentProof({
      imageBuffer: downloadedMedia.buffer,
      mimeType: downloadedMedia.mimeType,
      amount: booking.depositAmount,
      currency: booking.service.currency,
      expectedPayerName: getExpectedPayerName(booking),
      expectedFormalId: booking.payerFormalId || booking.client.formalId,
      paymentWindowStartsAt: dayjs(booking.createdAt).toISOString(),
      paymentWindowEndsAt: booking.holdExpiresAt ? dayjs(booking.holdExpiresAt).toISOString() : null
    });

    const proofRejectionReason = resolvePaymentProofRejectionReason(booking, validation);

    // Detectar comprobante duplicado por Nº de Solicitud / Folio / ID de transaccion
    const usedTransactionIds = Array.isArray(collectedData.usedTransactionIds)
      ? collectedData.usedTransactionIds
      : [];
    const incomingTxId = validation.transactionId;

    if (incomingTxId && usedTransactionIds.includes(incomingTxId)) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_partial_supplement',
        text: `⚠️ Este comprobante (Nº de Solicitud ${incomingTxId}) ya fue recibido anteriormente y no puede usarse nuevamente.\n\nPor favor envie el comprobante de la transferencia adicional que realizo.`,
        collectedData: {
          ...collectedData,
          bookingId
        },
        lastBookingId: bookingId
      });
    }

    if (proofRejectionReason) {
      const reason = proofRejectionReason;

      await bookingService.rejectPaymentProof(bookingId, {
        proofMetadata,
        validation: {
          ...validation,
          reason
        }
      });

      return buildReply({
        intent: 'booking',
        step: 'payment_proof_rejected_retry',
        text: `⚠️ No pude validar el comprobante.\n\nMotivo: ${reason}\n\nPuede reenviar una foto o captura mas clara mientras el horario siga reservado.`,
        collectedData: {
          ...collectedData,
          bookingId
        },
        lastBookingId: bookingId
      });
    }

    // Verificar si el monto detectado cubre lo que falta (considerando pagos parciales previos)
    const partialAmountPaid = collectedData.partialAmountPaid || 0;
    const effectiveMinimum = booking.depositAmount - partialAmountPaid;
    const detectedAmount = validation.detectedAmount;

    if (detectedAmount !== null && detectedAmount < effectiveMinimum) {
      // Comprobante autentico pero monto insuficiente → ofrecer opciones
      const newPartialTotal = partialAmountPaid + detectedAmount;
      const stillNeeded = booking.depositAmount - newPartialTotal;

      // Registrar el ID de transaccion para evitar que este comprobante sea reutilizado
      const newUsedTransactionIds = incomingTxId
        ? [...usedTransactionIds, incomingTxId]
        : usedTransactionIds;

      const partialText = partialAmountPaid > 0
        ? `Con este comprobante ya acumula ${newPartialTotal} ${booking.service.currency} de los ${booking.depositAmount} ${booking.service.currency} requeridos.`
        : `Recibimos su comprobante por ${detectedAmount} ${booking.service.currency}, pero el abono requerido es de ${booking.depositAmount} ${booking.service.currency}.`;

      return buildReply({
        intent: 'booking',
        step: 'awaiting_partial_supplement',
        text: `💡 ${partialText}\n\nLe faltan ${stillNeeded} ${booking.service.currency} para confirmar su hora.\n\nPuede elegir una de estas opciones:\n\n1. Transferir los ${stillNeeded} ${booking.service.currency} restantes y enviar ese comprobante dentro del tiempo disponible.\n\n2. Transferir nuevamente el total de ${booking.depositAmount} ${booking.service.currency}. Lo que ya abono (${newPartialTotal} ${booking.service.currency}) sera descontado del pago final al llegar al spa.`,
        collectedData: {
          ...collectedData,
          bookingId,
          partialAmountPaid: newPartialTotal,
          usedTransactionIds: newUsedTransactionIds
        },
        lastBookingId: bookingId
      });
    }

    const confirmedBooking = await bookingService.confirmPendingBooking(bookingId, {
      proofMetadata,
      validation
    });

    // Calcular overpago: considerar abonos parciales previos acumulados
    const totalPaidByClient = (partialAmountPaid || 0) + (detectedAmount !== null ? detectedAmount : 0);
    const overpaidAmount = totalPaidByClient > confirmedBooking.depositAmount
      ? totalPaidByClient - confirmedBooking.depositAmount
      : 0;

    const baseFallback = `Su cita para ${confirmedBooking.service.name} quedo confirmada para el ${dayjs(confirmedBooking.scheduledAt).format('YYYY-MM-DD HH:mm')}. Su pago fue validado correctamente y ya dejamos su hora reservada.`;
    const overpaymentNote = overpaidAmount > 0
      ? ` Notamos que en total abono ${totalPaidByClient} ${confirmedBooking.service.currency} (abono requerido: ${confirmedBooking.depositAmount} ${confirmedBooking.service.currency}). Conserve sus comprobantes: al llegar al spa le descontaremos los ${overpaidAmount} ${confirmedBooking.service.currency} adicionales del pago final.`
      : (partialAmountPaid > 0 ? ` La suma de sus abonos cubre el total requerido.` : '');
    const fallbackMessage = `${baseFallback}${overpaymentNote}`;

    const craftedMessage = await openAIService.craftBookingReply({
      fallbackMessage,
      bookingId: confirmedBooking.id,
      serviceName: confirmedBooking.service.name,
      scheduledAt: confirmedBooking.scheduledAt,
      ...(overpaidAmount > 0 && {
        overpaymentDetected: true,
        totalPaid: totalPaidByClient,
        depositRequired: confirmedBooking.depositAmount,
        overpaymentToDiscount: overpaidAmount,
        currency: confirmedBooking.service.currency
      }),
      ...(partialAmountPaid > 0 && overpaidAmount === 0 && {
        partialPaymentsUsed: true,
        totalPaid: totalPaidByClient,
        depositRequired: confirmedBooking.depositAmount
      })
    });

    return buildReply({
      intent: 'booking',
      step: 'booking_confirmed',
      text: craftedMessage,
      collectedData: {},
      lastBookingId: confirmedBooking.id,
      outbound: {
        kind: 'buttons',
        bodyText: `${craftedMessage}\n\n¿Desea realizar otra gestion?`,
        buttons: [
          { id: 'menu:book', title: 'Nueva reserva' },
          { id: 'menu:manage', title: 'Ver reservas' },
          { id: 'menu:main', title: 'Menu' }
        ]
      }
    });
  }

  async function handleManageBookingsMenu(clientId) {
    const upcomingBookings = await bookingService.findUpcomingBookingsForClient(clientId, { limit: 10 });

    if (!upcomingBookings.length) {
      return buildReply({
        intent: 'manage_bookings',
        step: 'manage_bookings_empty',
        text: '📭 No encuentro reservas proximas activas en este momento.',
        collectedData: {},
        outbound: {
          kind: 'buttons',
          bodyText: '📭 No hay reservas activas para gestionar.',
          buttons: [
            { id: 'menu:book', title: 'Reservar cita' },
            { id: 'menu:main', title: 'Volver' }
          ]
        }
      });
    }

    return buildReply({
      intent: 'manage_bookings',
      step: 'manage_bookings_menu',
      text: '📌 Estas son las opciones disponibles para sus reservas activas.',
      collectedData: {},
      outbound: {
        kind: 'buttons',
        bodyText: `📌 Tiene ${upcomingBookings.length} reserva${upcomingBookings.length === 1 ? '' : 's'} activa${upcomingBookings.length === 1 ? '' : 's'}.\n\n¿Que desea hacer?`,
        buttons: [
          { id: 'manage:view', title: 'Ver reservas' },
          { id: 'manage:cancel', title: 'Cancelar cita' },
          { id: 'menu:main', title: 'Volver' }
        ]
      }
    });
  }

  async function handleBookingStatusIntent(clientId) {
    const upcomingBookings = await bookingService.findUpcomingBookingsForClient(clientId, { limit: 10 });

    if (!upcomingBookings.length) {
      return handleViewBookingsIntent(clientId);
    }

    if (upcomingBookings.length === 1) {
      const booking = upcomingBookings[0];
      const scheduledAt = dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm');

      return buildReply({
        intent: 'manage_bookings',
        step: 'viewing_bookings',
        text: `📅 Su proxima reserva es para ${booking.service.name} el ${scheduledAt}.`,
        collectedData: {},
        outbound: {
          kind: 'buttons',
          bodyText: `📅 Su proxima reserva\n${booking.service.name}\n${scheduledAt}`,
          buttons: [
            { id: 'manage:cancel', title: 'Cancelar cita' },
            { id: 'menu:main', title: 'Volver' }
          ]
        }
      });
    }

    return handleViewBookingsIntent(clientId);
  }

  async function handleViewBookingsIntent(clientId) {
    const upcomingBookings = await bookingService.findUpcomingBookingsForClient(clientId, { limit: 10 });

    if (!upcomingBookings.length) {
      return buildReply({
        intent: 'manage_bookings',
        step: 'manage_bookings_empty',
        text: '📭 No encuentro reservas proximas activas en este momento.',
        collectedData: {},
        outbound: {
          kind: 'buttons',
          bodyText: '📭 No hay reservas activas para mostrar.',
          buttons: [
            { id: 'menu:book', title: 'Reservar cita' },
            { id: 'menu:main', title: 'Volver' }
          ]
        }
      });
    }

    const summary = upcomingBookings
      .slice(0, 10)
      .map((booking, index) => `${index + 1}. ${booking.service.name} - ${dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')}`)
      .join('\n');

    return buildReply({
      intent: 'manage_bookings',
      step: 'viewing_bookings',
      text: `📅 Estas son sus proximas reservas:\n\n${summary}`,
      collectedData: {},
      outbound: {
        kind: 'buttons',
        bodyText: `📅 Estas son sus proximas reservas:\n\n${summary}`,
        buttons: [
          { id: 'manage:cancel', title: 'Cancelar cita' },
          { id: 'menu:main', title: 'Volver' }
        ]
      }
    });
  }

  async function handleCancelBookingIntent(clientId) {
    const upcomingBookings = await bookingService.findUpcomingBookingsForClient(clientId, { limit: 10 });

    if (!upcomingBookings.length) {
      return buildReply({
        intent: 'cancel_booking',
        step: 'cancel_booking_empty',
        text: '📭 No encuentro reservas proximas confirmadas para cancelar.',
        collectedData: {}
      });
    }

    if (upcomingBookings.length === 1) {
      const booking = upcomingBookings[0];
      return buildReply({
        intent: 'cancel_booking',
        step: 'awaiting_cancel_confirmation',
        text: `⚠️ Encontre una reserva.\n\nServicio: ${booking.service.name}\nFecha: ${dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')}\n\n¿Desea cancelarla?`,
        collectedData: {},
        outbound: {
          kind: 'buttons',
          bodyText: `⚠️ Reserva encontrada\n${booking.service.name}\n${dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')}`,
          buttons: [
            { id: `cancelconfirm:${booking.id}`, title: 'Si, cancelar' },
            { id: 'menu:main', title: 'Volver' }
          ]
        }
      });
    }

    return buildReply({
      intent: 'cancel_booking',
      step: 'select_booking_to_cancel',
      text: '⚠️ Estas son sus proximas reservas confirmadas.\n\nElija cual quiere cancelar.',
      collectedData: {},
      outbound: {
        kind: 'list',
        bodyText: '⚠️ Seleccione la cita que desea cancelar.',
        buttonText: 'Ver reservas',
        sections: [
          {
            title: 'Reservas activas',
            rows: upcomingBookings.slice(0, 10).map((booking) => ({
              id: `cancelbooking:${booking.id}`,
              title: booking.service.name,
              description: dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')
            }))
          }
        ]
      }
    });
  }

  return {
    handleIncomingMessage
  };
}

async function sendReply(metaClient, whatsappNumber, reply) {
  if (!reply.outbound) {
    await metaClient.sendTextMessage(whatsappNumber, reply.text);
    return;
  }

  if (reply.outbound.kind === 'buttons') {
    await metaClient.sendButtonsMessage(whatsappNumber, reply.outbound.bodyText, reply.outbound.buttons);
    return;
  }

  if (reply.outbound.kind === 'list') {
    await metaClient.sendListMessage(
      whatsappNumber,
      reply.outbound.bodyText,
      reply.outbound.buttonText,
      reply.outbound.sections
    );
    return;
  }

  await metaClient.sendTextMessage(whatsappNumber, reply.text);
}

function buildUserFacingErrorMessage(error) {
  if (error instanceof AppError) {
    return error.message;
  }

  return '⚠️ Ocurrio un problema procesando su solicitud.\n\n¿Quiere que lo intentemos nuevamente?';
}

module.exports = { createChatOrchestrator };

function canStartBookingFromContext(currentStep) {
  return ['idle', 'main_menu', 'consultation_open', 'answered'].includes(currentStep || 'idle');
}

function resolvePaymentProofRejectionReason(booking, validation) {
  if (!validation.isValid && !hasUsableProofExtraction(validation)) {
    return validation.reason;
  }

  if (typeof validation.detectedAmount !== 'number') {
    return 'No se pudo leer con claridad el monto del comprobante.';
  }

  const expectedName = normalizePersonName(getExpectedPayerName(booking));
  const detectedName = normalizePersonName(validation.payerName);
  if (!expectedName || !detectedName || !personNameMatches(expectedName, detectedName)) {
    return 'El nombre del comprobante no coincide con los datos personales entregados para la reserva.';
  }

  const expectedFormalId = normalizeFormalId(booking.payerFormalId || booking.client.formalId);
  const detectedFormalId = normalizeFormalId(validation.payerFormalId);
  if (detectedFormalId && expectedFormalId && expectedFormalId !== detectedFormalId) {
    return 'El RUT o identificador del comprobante no coincide con el registrado en la reserva.';
  }

  const paymentTimestamp = parsePaymentTimestamp(validation.paymentTimestamp);
  if (!paymentTimestamp || !paymentTimestamp.isValid()) {
    return 'No se pudo validar la fecha y hora del pago del comprobante.';
  }

  if (paymentTimestamp && paymentTimestamp.isValid()) {
    // El timestamp ya viene en UTC gracias a parsePaymentTimestamp (asume -04:00 si falta offset).
    const windowStartsAt = dayjs(booking.createdAt);
    const windowEndsAt = booking.holdExpiresAt ? dayjs(booking.holdExpiresAt) : null;

    if (paymentTimestamp.isBefore(windowStartsAt)) {
      return `La hora del pago no coincide con la ventana valida de la reserva. El comprobante muestra ${paymentTimestamp.format('HH:mm')} y el pago fue realizado antes de crear la reserva.`;
    }

    if (windowEndsAt && paymentTimestamp.isAfter(windowEndsAt)) {
      return `La hora del pago no coincide con la ventana valida de la reserva. El comprobante muestra ${paymentTimestamp.format('HH:mm')} y el limite era ${windowEndsAt.format('HH:mm')}.`;
    }
  }

  return null;
}

function getExpectedPayerName(client) {
  const normalized = normalizePersonName([
    client?.payerName || client?.client?.name || client?.name,
    client?.payerLastName || client?.client?.lastName || client?.lastName
  ].filter(Boolean).join(' ').trim());
  return dedupeNameTokens(normalized.split(' ').filter(Boolean)).join(' ');
}

function normalizePersonName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function personNameMatches(expectedName, detectedName) {
  const expectedTokens = dedupeNameTokens(expectedName.split(' ').filter(Boolean));
  const detectedTokens = dedupeNameTokens(detectedName.split(' ').filter(Boolean));

  if (!expectedTokens.length || !detectedTokens.length) {
    return false;
  }

  const firstNameMatches = hasMatchingToken(expectedTokens[0], detectedTokens);
  if (!firstNameMatches) {
    return false;
  }

  const surnameTokens = expectedTokens.slice(1);
  if (!surnameTokens.length) {
    return true;
  }

  const matchedSurnameCount = surnameTokens.filter((token) => hasMatchingToken(token, detectedTokens)).length;
  const requiredSurnameMatches = Math.min(Math.max(1, surnameTokens.length - 1), surnameTokens.length);

  return matchedSurnameCount >= requiredSurnameMatches;
}

function normalizeFormalId(value) {
  return String(value || '').toUpperCase().replace(/[^0-9K]/g, '');
}

function parsePaymentTimestamp(value) {
  if (!value) {
    return null;
  }

  // Si el string ya incluye offset de zona horaria (+HH:mm, -HH:mm o Z), parsearlo directamente.
  // De lo contrario, asumir America/Santiago (UTC-4) para evitar falsos rechazos/aceptaciones
  // cuando el AI omite el offset en comprobantes chilenos.
  const str = String(value).trim().replace(' ', 'T');
  const hasOffset = /([+-]\d{2}:?\d{2}|Z)$/.test(str);
  const withOffset = hasOffset ? str : `${str}-04:00`;

  const parsed = dayjs(withOffset);
  return parsed.isValid() ? parsed : null;
}

function splitFullName(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return {
    name: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

function dedupeNameTokens(tokens) {
  return [...new Set(tokens)];
}

function hasMatchingToken(token, candidates) {
  return candidates.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate));
}

function hasUsableProofExtraction(validation) {
  return Boolean(
    typeof validation?.detectedAmount === 'number' ||
    validation?.payerName ||
    validation?.paymentTimestamp ||
    validation?.transactionId
  );
}

function preserveSystemCollectedData(existingData, nextData) {
  const existing = existingData && typeof existingData === 'object' ? existingData : {};
  const next = nextData && typeof nextData === 'object' ? nextData : {};

  if (!existing.chatwoot) {
    return nextData;
  }

  return {
    ...next,
    chatwoot: existing.chatwoot
  };
}
