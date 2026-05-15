const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const { env } = require('../config/env');
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

dayjs.extend(utc);
dayjs.extend(timezone);

function createChatOrchestrator({
  openAIService,
  clientService,
  conversationService,
  messageService,
  bookingService,
  campaignService,
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
    await clientService.updateClient(client.id, {
      lastInteractionAt: new Date()
    }).catch(() => null);
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
      logger.error('Conversation routing failed', {
        conversationId: conversation.id,
        clientId: client.id,
        currentIntent: conversation.currentIntent || null,
        currentStep: conversation.currentStep || null,
        providerMessageId: message.providerMessageId || null,
        messageType: message.type || null,
        error: error.message
      });

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
    const campaignContext = normalizeCampaignContext(collectedData.campaignContext);
    const campaignOffer = campaignContext?.offerId
      ? await campaignService.getOfferById(campaignContext.offerId).catch(() => null)
      : null;
    const campaignServiceId = campaignContext?.serviceId || campaignOffer?.serviceId || null;
    const campaignServiceRecord = campaignServiceId
      ? await serviceCatalogService.getServiceById(campaignServiceId).catch(() => null)
      : null;
    const campaignEligibleStep = ![
      // Pasos de reserva en progreso – el intro de campaña no debe interrumpir
      'awaiting_service',
      'awaiting_date',
      'awaiting_time',
      'awaiting_name',
      'awaiting_last_name',
      'awaiting_formal_id',
      'awaiting_payer_role',
      'awaiting_payer_confirmation',
      'awaiting_payer_name',
      'awaiting_payer_formal_id',
      'awaiting_payer_email',
      'awaiting_payment_method',
      'editing_payer_name',
      'editing_payer_formal_id',
      // Pasos de pago
      'awaiting_payment_proof',
      'payment_proof_rejected_retry',
      'awaiting_partial_supplement'
    ].includes(conversation.currentStep);


    if (campaignContext?.campaignRecipientId && text && isCampaignOptOutMessage(lowerText)) {
      await clientService.updateClient(client.id, {
        marketingOptOut: true,
        marketingOptOutAt: new Date()
      }).catch(() => null);
      await campaignService.markRecipientOptedOut(campaignContext.campaignRecipientId).catch(() => null);

      return buildReply({
        intent: 'campaign',
        step: 'campaign_opted_out',
        text: 'Entendido. Ya registramos su preferencia y no volvera a recibir promociones por WhatsApp.',
        collectedData: {
          ...collectedData,
          campaignContext: null
        }
      });
    }

    if (campaignContext?.campaignRecipientId && text && !message.media) {
      await campaignService.markRecipientResponded(campaignContext.campaignRecipientId).catch(() => null);
    }

    if (campaignContext && campaignEligibleStep && text && asksForCampaignOfferPrice(lowerText)) {
      return buildCampaignPriceReply({
        offer: campaignOffer,
        service: campaignServiceRecord,
        collectedData
      });
    }

    // Cliente confirmo el intro de campaña via boton → continuar al flujo de reserva
    if (selectedAction?.type === 'campaignbook' && selectedAction.value === 'confirm') {
      if (campaignServiceRecord) {
        return bookingFlow.buildServiceSelectionReply(client, campaignServiceRecord, {
          ...collectedData,
          serviceId: campaignServiceRecord.id
        });
      }
      return bookingFlow.startBookingFlow(client, collectedData);
    }
    const isExplicitOtherService = matchedService && campaignServiceRecord && matchedService.id !== campaignServiceRecord.id;

    if (campaignContext && campaignEligibleStep && text && !isExplicitOtherService && (looksLikeCampaignInterest(lowerText) || resolvedIntent === 'booking')) {
      if (campaignServiceRecord) {
        // Siempre mostrar el intro de campaña con beneficios y aclaración de pago.
        // La única forma de avanzar a la reserva es con el botón "Si, reservar ahora"
        // (acción campaignbook:confirm, manejada arriba).
        return buildCampaignBookingIntroReply({
          client,
          offer: campaignOffer,
          service: campaignServiceRecord,
          collectedData,
          depositAmount: env.bookingDepositAmount
        });
      }

      return buildReply({
        intent: 'campaign',
        step: 'campaign_interest',
        text: 'Perfecto. Puedo ayudarle a reservar la promocion.\n\nSeleccione el servicio que desea revisar.',
        collectedData,
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }


    if (wantsMainMenu(lowerText) || (selectedAction?.type === 'menu' && selectedAction.value === 'main')) {
      return welcomeFlow.buildMainMenuReply();
    }

    if (selectedAction?.type === 'faq') {
      return faqFlow.buildFaqReply(selectedAction.value, collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'book') {
      return bookingFlow.startBookingFlow(client, { campaignContext: null });
    }

    if (selectedAction?.type === 'retrydates') {
      return bookingFlow.buildDatePrompt(collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'services') {
      return servicesFlow.buildServiceListReply({ campaignContext: null });
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'consult') {
      return faqFlow.buildConsultationWelcomeReply({ campaignContext: null });
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
        collectedData: { campaignContext: null }
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
        text: `⚠️ Esta a punto de cancelar su cita.\n\nServicio: ${selectedBooking.service.name}\nFecha: ${formatBookingDateTime(selectedBooking.scheduledAt)}\n\n¿Desea confirmar la cancelacion?`,
        collectedData,
        outbound: {
          kind: 'buttons',
          bodyText: `⚠️ Confirmar cancelacion de ${selectedBooking.service.name}\n${formatBookingDateTime(selectedBooking.scheduledAt)}`,
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
      const baseText = `✅ Su cita de ${cancelledBooking.service.name} para el ${formatBookingDateTime(cancelledBooking.scheduledAt)} fue cancelada correctamente.`;
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

    // Bloque de pago y expiración: responde primero si la reserva ya vencio,
    // aun si la conversacion quedo en main_menu.
    const paymentSteps = ['awaiting_payment_proof', 'awaiting_partial_supplement', 'payment_proof_rejected_retry'];
    const bookingId = conversation.lastBookingId || collectedData.bookingId;
    const holdBooking = bookingId ? await bookingService.getBookingById(bookingId).catch(() => null) : null;
    const holdInfo = getHoldState(holdBooking);
    const shouldCheckHold = paymentSteps.includes(conversation.currentStep) || conversation.currentStep === 'hold_expired';
    const paymentInquiry = text && asksForPaymentFollowup(lowerText);

    if (!selectedAction && (shouldCheckHold || paymentInquiry) && holdInfo.isExpired && text) {
      return buildExpiredHoldReply(holdBooking);
    }

    if (paymentSteps.includes(conversation.currentStep) && text && holdBooking) {
      const wantsTimeRemaining = asksForHoldTimeRemaining(lowerText);
      const wantsPaymentAmount = asksForHoldPaymentAmount(lowerText);
      const wantsPaymentDestination = asksForHoldPaymentDestination(lowerText);
      const requestedTopics = [wantsTimeRemaining, wantsPaymentAmount, wantsPaymentDestination].filter(Boolean).length;

      if (requestedTopics >= 2) {
        return buildHoldCompositeReply(holdBooking, holdInfo.minutesLeft, collectedData, bookingId, {
          wantsTimeRemaining,
          wantsPaymentAmount,
          wantsPaymentDestination
        });
      }

      if (wantsTimeRemaining) {
        return buildHoldTimeReply(holdBooking, holdInfo.minutesLeft, conversation.currentStep, collectedData, bookingId);
      }

      if (wantsPaymentAmount) {
        return buildHoldPaymentDetailsReply(holdBooking, collectedData, bookingId);
      }

      if (wantsPaymentDestination) {
        return buildHoldPaymentDestinationReply(holdBooking, collectedData, bookingId);
      }

      if (asksForPaymentInfo(lowerText)) {
        return buildHoldPaymentInfoReply(holdBooking, holdInfo.minutesLeft, collectedData, bookingId);
      }

      return buildReply({
        intent: 'booking',
        step: conversation.currentStep,
        text: '⏳ Su reserva sigue activa.\n\nPuede consultarme el monto, la cuenta o el tiempo restante, o enviar aqui la foto o captura del comprobante para confirmarlo.',
        collectedData,
        lastBookingId: bookingId
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
        text: '📸 Para validar el abono, necesito que envie una foto o captura del comprobante dentro del tiempo indicado. Tambien puede preguntarme el monto o los datos de la cuenta.',
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
    const expectedTransferRecipient = parseTransferRecipientDetails(env.spaTransferDetails);
    const validation = await openAIService.validatePaymentProof({
      imageBuffer: downloadedMedia.buffer,
      mimeType: downloadedMedia.mimeType,
      amount: booking.depositAmount,
      currency: booking.service.currency,
      expectedPayerName: getExpectedPayerName(booking),
      expectedFormalId: booking.payerFormalId || booking.client.formalId,
      expectedRecipientName: expectedTransferRecipient.name,
      expectedRecipientFormalId: expectedTransferRecipient.formalId,
      expectedRecipientAccountNumber: expectedTransferRecipient.accountNumber,
      expectedRecipientBank: expectedTransferRecipient.bank,
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

    const scheduledAtLocal = formatBookingDateTime(confirmedBooking.scheduledAt);
    const baseFallback = `Su cita para ${confirmedBooking.service.name} quedo confirmada para el ${scheduledAtLocal}. Su pago fue validado correctamente y ya dejamos su hora reservada.`;
    const overpaymentNote = overpaidAmount > 0
      ? ` Notamos que en total abono ${totalPaidByClient} ${confirmedBooking.service.currency} (abono requerido: ${confirmedBooking.depositAmount} ${confirmedBooking.service.currency}). Conserve sus comprobantes: al llegar al spa le descontaremos los ${overpaidAmount} ${confirmedBooking.service.currency} adicionales del pago final.`
      : (partialAmountPaid > 0 ? ` La suma de sus abonos cubre el total requerido.` : '');
    const fallbackMessage = `${baseFallback}${overpaymentNote}`;

    const craftedMessage = await openAIService.craftBookingReply({
      fallbackMessage,
      bookingId: confirmedBooking.id,
      serviceName: confirmedBooking.service.name,
      scheduledAt: scheduledAtLocal,
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
      collectedData: {
        campaignContext: null
      },
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
      const scheduledAt = formatBookingDateTime(booking.scheduledAt);

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
      .map((booking, index) => `${index + 1}. ${booking.service.name} - ${formatBookingDateTime(booking.scheduledAt)}`)
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
        text: `⚠️ Encontre una reserva.\n\nServicio: ${booking.service.name}\nFecha: ${formatBookingDateTime(booking.scheduledAt)}\n\n¿Desea cancelarla?`,
        collectedData: {},
        outbound: {
          kind: 'buttons',
          bodyText: `⚠️ Reserva encontrada\n${booking.service.name}\n${formatBookingDateTime(booking.scheduledAt)}`,
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
              description: formatBookingDateTime(booking.scheduledAt)
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

function normalizeCampaignContext(value) {
  return value && typeof value === 'object' && value.campaignId && value.offerId
    ? value
    : null;
}

function isCampaignOptOutMessage(text) {
  return /\b(stop|salir|no quiero recibir mas mensajes|no quiero recibir mensajes|no mas mensajes|baja)\b/.test(normalizeSearchText(text));
}

function looksLikeCampaignInterest(text) {
  return /(me interesa|quiero reservar|reservar|agendar|que horarios hay|que horarios tienen|horarios disponibles|quiero esa promo|quiero la promo)/.test(normalizeSearchText(text));
}

function asksForCampaignOfferPrice(text) {
  return /(cuanto sale|cuanto cuesta|precio|valor|descuento|promo|promocion|promoción)/.test(normalizeSearchText(text));
}

function buildCampaignPriceReply({ offer, service, collectedData }) {
  if (!offer || !service) {
    return buildReply({
      intent: 'campaign',
      step: 'campaign_price_unknown',
      text: 'Puedo ayudarle con la promocion, pero en este momento no logre recuperar el detalle del servicio asociado.',
      collectedData
    });
  }

  const basePrice = Number(service.price || 0);
  let finalPrice = basePrice;
  let benefitLine = 'Beneficio: promocion comercial asociada.';

  if (offer.discountType === 'PERCENTAGE') {
    finalPrice = Math.max(0, basePrice - Math.round((basePrice * Number(offer.discountValue || 0)) / 100));
    benefitLine = `Beneficio: ${offer.discountValue}% de descuento.`;
  } else if (offer.discountType === 'FIXED_AMOUNT') {
    finalPrice = Math.max(0, basePrice - Number(offer.discountValue || 0));
    benefitLine = `Beneficio: descuento de $${Number(offer.discountValue || 0).toLocaleString('es-CL')} ${service.currency}.`;
  } else if (offer.customText) {
    benefitLine = `Beneficio: ${offer.customText}`;
  }

  return buildReply({
    intent: 'campaign',
    step: 'campaign_price_answered',
    text: [
      `✨ ${service.name}`,
      `Precio base: $${basePrice.toLocaleString('es-CL')} ${service.currency}.`,
      benefitLine,
      `Precio final promocional: $${finalPrice.toLocaleString('es-CL')} ${service.currency}.`,
      'El abono para reservar se mantiene igual que siempre y el descuento se aplica al saldo final en el spa.'
    ].join('\n'),
    collectedData
  });
}

/**
 * Muestra un mensaje introductorio cuando el cliente responde a una campaña con intención de reservar.
 * Explica el servicio, el beneficio de la oferta y aclara que:
 *   - El abono de reserva es el monto habitual (sin descuento)
 *   - La promoción se aplica al SALDO TOTAL el día de la cita en el spa
 */
function buildCampaignBookingIntroReply({ client, offer, service, collectedData, depositAmount }) {
  const firstName = client.name ? client.name.split(' ')[0] : null;
  const greeting = firstName ? `Hola ${firstName}, ` : '';
  const serviceName = service.name;

  let benefitLine = `Tienes una oferta especial en ${serviceName}.`;
  if (offer?.discountType === 'PERCENTAGE' && offer.discountValue) {
    benefitLine = `${offer.discountValue}% de descuento en ${serviceName}.`;
  } else if (offer?.discountType === 'FIXED_AMOUNT' && offer.discountValue) {
    benefitLine = `$${Number(offer.discountValue).toLocaleString('es-CL')} CLP de descuento en ${serviceName}.`;
  } else if (offer?.customText) {
    benefitLine = offer.customText;
  }

  const lines = [
    `${greeting}que bueno que quieres aprovechar la promo.`,
    '',
    `Servicio: ${serviceName}`,
    `Beneficio: ${benefitLine}`,
    '',
    'Como funciona:',
    `- Para reservar pagas el abono habitual de ${depositAmount} CLP (igual que siempre).`,
    '- La promocion se aplica sobre el saldo total el dia de tu cita, al momento de pagar en el spa.',
    '- No hay ningun descuento sobre el abono de reserva.',
    '',
    'Quieres continuar con la reserva?'
  ];

  const bodyText = lines.join('\n');

  return buildReply({
    intent: 'campaign',
    step: 'campaign_booking_intro',
    text: bodyText,
    collectedData: {
      ...collectedData,
      serviceId: service.id
    },
    outbound: {
      kind: 'buttons',
      bodyText,
      buttons: [
        { id: 'campaignbook:confirm', title: 'Si, reservar ahora' },
        { id: 'menu:main', title: 'Volver al menu' }
      ]
    }
  });
}

function resolvePaymentProofRejectionReason(booking, validation) {
  if (!validation.isValid && !hasUsableProofExtraction(validation)) {
    return validation.reason;
  }

  if (typeof validation.detectedAmount !== 'number') {
    return 'No se pudo leer con claridad el monto del comprobante.';
  }

  if (!validation.transactionId) {
    return 'No se pudo leer el numero de operacion del comprobante.';
  }

  const expectedRecipient = parseTransferRecipientDetails(env.spaTransferDetails);
  const detectedRecipientAccountNumber = normalizeAccountNumber(validation.recipientAccountNumber);
  const accountNumberMatches = Boolean(
    expectedRecipient.accountNumber &&
    detectedRecipientAccountNumber &&
    expectedRecipient.accountNumber === detectedRecipientAccountNumber
  );
  if (!expectedRecipient.accountNumber || !detectedRecipientAccountNumber || expectedRecipient.accountNumber !== detectedRecipientAccountNumber) {
    return 'La cuenta destino del comprobante no coincide con la cuenta bancaria configurada para recibir el abono.';
  }

  const expectedRecipientFormalId = normalizeFormalId(expectedRecipient.formalId);
  const detectedRecipientFormalId = normalizeFormalId(validation.recipientFormalId);
  const recipientFormalIdMatches = matchesFormalId(expectedRecipientFormalId, detectedRecipientFormalId);

  const expectedRecipientBank = normalizeSearchText(expectedRecipient.bank);
  const detectedRecipientBank = normalizeSearchText(validation.recipientBank);
  const recipientBankMatches = Boolean(
    expectedRecipientBank &&
    detectedRecipientBank &&
    expectedRecipientBank === detectedRecipientBank
  );
  if (!recipientBankMatches) {
    return 'El banco destino del comprobante no coincide con el configurado para recibir el abono.';
  }

  const detectedRecipientName = normalizePersonName(validation.recipientName);
  const hasStrongRecipientMatch = accountNumberMatches || recipientFormalIdMatches;
  const recipientAliases = [
    'gonzalo garrote perez'
  ].map(normalizePersonName);
  const recipientNameMatches = expectedRecipient.name && detectedRecipientName
    ? personNameMatches(expectedRecipient.name, detectedRecipientName)
    : false;
  const aliasMatches = recipientAliases.some((alias) =>
    alias && detectedRecipientName && personNameMatches(alias, detectedRecipientName)
  );

  if (!expectedRecipient.name || !detectedRecipientName || (!recipientNameMatches && !aliasMatches)) {
    return 'El destinatario del comprobante no coincide con el titular configurado para recibir el abono.';
  }

  if (!hasStrongRecipientMatch && !recipientBankMatches) {
    return 'El destinatario del comprobante no coincide con el titular configurado para recibir el abono.';
  }

  if (!accountNumberMatches && !recipientFormalIdMatches) {
    return 'El destinatario del comprobante no coincide con el titular configurado para recibir el abono.';
  }

  if (!recipientFormalIdMatches && !accountNumberMatches) {
    return 'El RUT del destinatario del comprobante no coincide con el configurado para recibir el abono.';
  }

  const expectedName = normalizePersonName(getExpectedPayerName(booking));
  const detectedName = normalizePersonName(validation.payerName);
  const expectedFormalId = normalizeFormalIdLoose(booking.payerFormalId || booking.client.formalId);
  const detectedFormalId = normalizeFormalIdLoose(validation.payerFormalId);
  const detectedPayerAccountNumber = normalizeAccountNumber(validation.payerAccountNumber);

  const nameProvided = Boolean(detectedName);
  const formalIdProvided = Boolean(detectedFormalId || detectedPayerAccountNumber);
  const nameMatches = expectedName && detectedName && personNameMatches(expectedName, detectedName);
  const formalIdMatches = matchesPayerIdentity({
    expectedFormalId,
    detectedFormalId,
    detectedAccountNumber: detectedPayerAccountNumber
  });

  if (nameProvided && formalIdProvided) {
    if (!nameMatches) {
      return 'El nombre del comprobante no coincide con los datos personales entregados para la reserva.';
    }
    if (!formalIdMatches) {
      return 'El RUT o identificador del comprobante no coincide con el registrado en la reserva.';
    }
  } else if (nameProvided) {
    if (!nameMatches) {
      return 'El nombre del comprobante no coincide con los datos personales entregados para la reserva.';
    }
  } else if (formalIdProvided) {
    if (!formalIdMatches) {
      return 'El RUT o identificador del comprobante no coincide con el registrado en la reserva.';
    }
  } else {
    return 'No se pudo leer el nombre o el RUT del pagador en el comprobante.';
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

function normalizeFormalIdLoose(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '')
    .replace(/^0+/, '');
}

function matchesFormalId(expected, detected) {
  if (!expected || !detected) {
    return false;
  }

  if (expected === detected) {
    return true;
  }

  const expectedCore = stripFormalIdCheckDigit(expected);
  const detectedCore = stripFormalIdCheckDigit(detected);
  return Boolean(expectedCore && detectedCore && expectedCore === detectedCore);
}

function matchesPayerIdentity({ expectedFormalId, detectedFormalId, detectedAccountNumber }) {
  if (!expectedFormalId) {
    return false;
  }

  if (matchesFormalId(expectedFormalId, detectedFormalId)) {
    return true;
  }

  return matchesFormalIdAccountVariant(expectedFormalId, detectedAccountNumber);
}

function matchesFormalIdAccountVariant(expectedFormalId, accountNumber) {
  if (!expectedFormalId || !accountNumber) {
    return false;
  }

  const normalizedExpected = normalizeFormalIdLoose(expectedFormalId);
  const normalizedAccount = normalizeAccountLikeFormalId(accountNumber);
  if (!normalizedExpected || !normalizedAccount) {
    return false;
  }

  if (normalizedExpected === normalizedAccount) {
    return true;
  }

  const expectedCore = stripFormalIdCheckDigit(normalizedExpected);
  const accountCore = stripFormalIdCheckDigit(normalizedAccount);

  if (expectedCore && (normalizedAccount === expectedCore || accountCore === expectedCore)) {
    return true;
  }

  if (normalizedExpected.length < normalizedAccount.length && normalizedAccount.endsWith(normalizedExpected)) {
    return true;
  }

  return Boolean(expectedCore && expectedCore.length < normalizedAccount.length && normalizedAccount.endsWith(expectedCore));
}

function stripFormalIdCheckDigit(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (normalized.length <= 1) {
    return '';
  }
  return normalized.slice(0, -1);
}

function normalizeAccountNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeAccountLikeFormalId(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '')
    .replace(/^0+/, '');
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    validation?.payerFormalId ||
    validation?.payerAccountNumber ||
    validation?.recipientName ||
    validation?.recipientAccountNumber ||
    validation?.paymentTimestamp ||
    validation?.transactionId
  );
}

function asksForPaymentAmount(text) {
  return /(cu[aá]nto (es|era|seria)? ?(lo )?(que )?(debo|tengo que)( de)? (pagar|abonar|transferir)|cu[aá]nto debo( de)? pagar|cu[aá]nto tengo que pagar|monto del abono|cu[aá]l es el monto|cu[aá]nto transfiero|cu[aá]nto deposito|cu[aá]nto tengo que abonar)/.test(String(text || '').toLowerCase());
}

function asksForPaymentDestination(text) {
  return /(a que cuenta|a qu[eé] cuenta|que cuenta|cuenta destino|datos bancarios|datos de cuenta|a quien le transfiero|a nombre de quien|titular|banco|rut|numero de cuenta|n[uú]mero de cuenta|correo|transferencia)/.test(String(text || '').toLowerCase());
}

function asksForPaymentInfo(text) {
  return /(cu[aá]nto era|cuanto era|cuanto es|a que cuenta|datos bancarios|monto|abono|pago|transferencia)/.test(String(text || '').toLowerCase());
}

function asksForPaymentFollowup(text) {
  return asksForPaymentAmount(text) ||
    asksForPaymentDestination(text) ||
    asksForPaymentInfo(text) ||
    asksForTimeRemaining(text) ||
    asksForHoldPaymentAmount(text) ||
    asksForHoldPaymentDestination(text) ||
    asksForHoldTimeRemaining(text);
}

function asksForHoldPaymentAmount(text) {
  const normalized = normalizeSearchText(text);
  return asksForPaymentAmount(text) ||
    /(cuanto es|y cuanto es|cuanto hay que pagar|cuanto debo pagar|cuanto tengo que pagar|cuanto debo abonar|cuanto tengo que abonar|cuanto falta pagar|cuanto me falta|cuanto resta|monto a pagar|valor del abono)/.test(normalized);
}

function asksForHoldPaymentDestination(text) {
  return asksForPaymentDestination(text);
}

function asksForHoldTimeRemaining(text) {
  const normalized = normalizeSearchText(text);
  return asksForTimeRemaining(text) ||
    /(cuanto tiempo me queda|cuanto me queda|cuanto tiempo queda|tiempo restante|cuantos minutos quedan|cuantos minutos me quedan)/.test(normalized);
}

function getHoldState(booking) {
  if (!booking) {
    return { isExpired: false, minutesLeft: 0 };
  }

  const expiresAt = booking.holdExpiresAt ? dayjs(booking.holdExpiresAt) : null;
  const minutesLeft = expiresAt ? Math.ceil(expiresAt.diff(dayjs(), 'second') / 60) : 0;
  const isExpired = Boolean(
    booking.paymentStatus === 'EXPIRED' ||
    booking.status === 'CANCELLED' ||
    (expiresAt && minutesLeft <= 0)
  );

  return { isExpired, minutesLeft };
}

function buildHoldPaymentDetailsReply(holdBooking, collectedData, bookingId) {
  const partialAmountPaid = Number(collectedData.partialAmountPaid || 0);
  const totalRequired = Number(holdBooking.depositAmount || 0);
  const remainingAmount = Math.max(totalRequired - partialAmountPaid, 0);
  const currency = holdBooking.service?.currency || 'CLP';
  const partialLine = partialAmountPaid > 0
    ? `\n\nHasta ahora registra ${partialAmountPaid} ${currency} abonados, por lo que le faltan ${remainingAmount} ${currency}.`
    : '';

  return buildReply({
    intent: 'booking',
    step: holdBooking.paymentStatus === 'EXPIRED' ? 'hold_expired' : 'awaiting_payment_proof',
    text: `💰 El abono requerido para confirmar esta reserva es de ${remainingAmount} ${currency}.${partialLine}\n\nCuando realice la transferencia, envie aqui la foto o captura del comprobante para validarlo.`,
    collectedData,
    lastBookingId: bookingId
  });
}

function buildHoldPaymentDestinationReply(holdBooking, collectedData, bookingId) {
  const details = String(env.spaTransferDetails || '').trim() || 'No tengo cargados los datos bancarios en este momento.';
  return buildReply({
    intent: 'booking',
    step: holdBooking.paymentStatus === 'EXPIRED' ? 'hold_expired' : 'awaiting_payment_proof',
    text: `🏦 Estos son los datos para realizar el abono:\n\n${details}\n\nSi lo desea, tambien puedo indicarle el monto exacto a pagar.`,
    collectedData,
    lastBookingId: bookingId
  });
}

function buildHoldPaymentInfoReply(holdBooking, minutesLeft, collectedData, bookingId) {
  const totalRequired = Number(holdBooking.depositAmount || 0);
  const currency = holdBooking.service?.currency || 'CLP';
  const timeText = minutesLeft > 0 ? ` Le quedan aproximadamente ${minutesLeft} ${minutesLeft === 1 ? 'minuto' : 'minutos'}.` : '';
  return buildReply({
    intent: 'booking',
    step: holdBooking.paymentStatus === 'EXPIRED' ? 'hold_expired' : 'awaiting_payment_proof',
    text: `💬 El abono es de ${totalRequired} ${currency}.\n\nPuede transferirlo a la cuenta informada y enviar aqui el comprobante.${timeText}`,
    collectedData,
    lastBookingId: bookingId
  });
}

function buildHoldCompositeReply(holdBooking, minutesLeft, collectedData, bookingId, requests = {}) {
  const partialAmountPaid = Number(collectedData.partialAmountPaid || 0);
  const totalRequired = Number(holdBooking.depositAmount || 0);
  const remainingAmount = Math.max(totalRequired - partialAmountPaid, 0);
  const currency = holdBooking.service?.currency || 'CLP';
  const minuteWord = minutesLeft === 1 ? 'minuto' : 'minutos';
  const parts = [];

  if (requests.wantsTimeRemaining) {
    parts.push(`⏳ Le quedan aproximadamente ${minutesLeft} ${minuteWord} para enviar su comprobante y confirmar su cita.`);
  }

  if (requests.wantsPaymentAmount) {
    const partialLine = partialAmountPaid > 0
      ? ` Ya registra ${partialAmountPaid} ${currency} abonados, por lo que le faltan ${remainingAmount} ${currency}.`
      : '';
    parts.push(`💰 El abono requerido para confirmar esta reserva es de ${remainingAmount} ${currency}.${partialLine}`);
  }

  if (requests.wantsPaymentDestination) {
    const details = String(env.spaTransferDetails || '').trim() || 'No tengo cargados los datos bancarios en este momento.';
    parts.push(`🏦 Estos son los datos para realizar el abono:\n\n${details}`);
  }

  parts.push('Cuando realice la transferencia, envie aqui la foto o captura del comprobante para validarlo.');

  return buildReply({
    intent: 'booking',
    step: holdBooking.paymentStatus === 'EXPIRED' ? 'hold_expired' : 'awaiting_payment_proof',
    text: parts.join('\n\n'),
    collectedData,
    lastBookingId: bookingId
  });
}

function buildHoldTimeReply(holdBooking, minutesLeft, step, collectedData, bookingId) {
  const minuteWord = minutesLeft === 1 ? 'minuto' : 'minutos';
  return buildReply({
    intent: 'booking',
    step,
    text: `⏳ Le quedan aproximadamente ${minutesLeft} ${minuteWord} para enviar su comprobante y confirmar su cita.`,
    collectedData,
    lastBookingId: bookingId
  });
}

function buildExpiredHoldReply(holdBooking) {
  const text = '⌛ El tiempo para confirmar la cita ya vencio y el horario fue liberado.';
  const serviceName = holdBooking?.service?.name || 'su reserva';
  return buildReply({
    intent: 'booking',
    step: 'main_menu',
    text: `${text}\n\nSeleccione una opcion para continuar sobre ${serviceName}:`,
    collectedData: {},
    outbound: {
      kind: 'buttons',
      bodyText: `${text}\n\n¿Que desea hacer ahora?`,
      buttons: [
        { id: 'menu:main', title: 'Menu principal' },
        { id: 'menu:book', title: 'Reservar otro servicio' }
      ]
    }
  });
}

function preserveSystemCollectedData(existingData, nextData) {
  const existing = existingData && typeof existingData === 'object' ? existingData : {};
  const next = nextData && typeof nextData === 'object' ? nextData : {};
  const merged = {
    ...next
  };

  if (!existing.chatwoot) {
    if (existing.campaignContext && !Object.prototype.hasOwnProperty.call(next, 'campaignContext')) {
      merged.campaignContext = existing.campaignContext;
    }
  } else {
    merged.chatwoot = existing.chatwoot;
  }

  if (existing.campaignContext && !Object.prototype.hasOwnProperty.call(next, 'campaignContext')) {
    merged.campaignContext = existing.campaignContext;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'campaignContext') && next.campaignContext === null) {
    delete merged.campaignContext;
  }

  return merged;
}

function formatBookingDateTime(value) {
  return dayjs(value).tz(env.googleTimezone).format('YYYY-MM-DD HH:mm');
}

function parseTransferRecipientDetails(transferDetails) {
  const text = String(transferDetails || '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const details = {
    name: '',
    formalId: '',
    bank: '',
    accountNumber: ''
  };

  for (const line of lines) {
    const normalizedLine = normalizeSearchText(line);

    if (!details.name && normalizedLine.startsWith('titular ')) {
      details.name = normalizePersonName(line.split(':').slice(1).join(':').trim());
      continue;
    }

    if (!details.formalId && normalizedLine.startsWith('rut ')) {
      details.formalId = line.split(':').slice(1).join(':').trim();
      continue;
    }

    if (!details.bank && normalizedLine.startsWith('banco ')) {
      details.bank = line.split(':').slice(1).join(':').trim();
      continue;
    }

    if (!details.accountNumber && normalizedLine.startsWith('numero de cuenta ')) {
      details.accountNumber = normalizeAccountNumber(line.split(':').slice(1).join(':').trim());
    }
  }

  return details;
}
