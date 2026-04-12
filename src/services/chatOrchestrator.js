const dayjs = require('dayjs');
const { AppError } = require('../lib/errors');

function createChatOrchestrator({
  openAIService,
  clientService,
  conversationService,
  messageService,
  bookingService,
  serviceCatalogService,
  metaClient
}) {
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
    const conversation = await conversationService.getOrCreateActiveConversation(client.id);

    await messageService.createIncomingMessage({
      conversationId: conversation.id,
      clientId: client.id,
      content: message.text || message.selectedId || '',
      providerId: message.providerMessageId,
      metadata: {
        timestamp: message.timestamp,
        type: message.type,
        selectedId: message.selectedId || null
      }
    });

    let reply;

    try {
      const intentResult = await openAIService.classifyIntent(message.text || message.selectedId || '');
      reply = await routeConversation({
        client,
        conversation,
        text: message.text || '',
        selectedId: message.selectedId || null,
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
      collectedData: reply.collectedData || conversation.collectedData || undefined,
      lastBookingId: reply.lastBookingId || conversation.lastBookingId || undefined
    });

    try {
      await sendReply(metaClient, client.whatsappNumber, reply);
    } catch (_error) {
      return reply;
    }

    return reply;
  }

  async function routeConversation({ client, conversation, text, selectedId, intentResult }) {
    const lowerText = String(text || '').toLowerCase();
    const collectedData = normalizeCollectedData(conversation.collectedData);
    const selectedAction = parseSelectedAction(selectedId);
    const matchedService = await resolveServiceSelection({ selectedAction, text, serviceCatalogService });
    const deterministicIntent = inferDeterministicIntent(lowerText, matchedService, selectedAction);
    const resolvedIntent = deterministicIntent || intentResult.intent;

    if (wantsMainMenu(lowerText) || selectedAction?.type === 'menu' && selectedAction.value === 'main') {
      return buildMainMenuReply();
    }

    if (selectedAction?.type === 'faq') {
      return await buildFaqReply(selectedAction.value, collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'book') {
      return await startBookingFlow(client, collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'services') {
      return await buildServiceListReply(collectedData);
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'manage') {
      return buildReply({
        intent: 'manage_booking',
        step: 'manage_booking',
        text: 'Puede gestionar sus reservas por este chat indicando si desea cancelar o reagendar. Si prefiere asistencia directa, tambien puede contactarnos al telefono del spa.',
        collectedData,
        outbound: {
          kind: 'buttons',
          bodyText: 'Gestion de reservas',
          buttons: [
            { id: 'menu:main', title: 'Menu principal' },
            { id: 'faq:contacto', title: 'Contacto' },
            { id: 'faq:politicas', title: 'Politicas' }
          ]
        }
      });
    }

    if (selectedAction?.type === 'menu' && selectedAction.value === 'exit') {
      return buildReply({
        intent: 'exit',
        step: 'main_menu',
        text: 'Con gusto. Cuando necesite ayuda nuevamente, estare disponible para asistirle.',
        collectedData: {}
      });
    }

    if (selectedAction?.type === 'slot') {
      return await confirmBookingTime({
        client,
        collectedData,
        selectedValue: selectedAction.value
      });
    }

    if (selectedAction?.type === 'confirm') {
      if (selectedAction.value === 'restart') {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_service',
          text: 'Claro, partamos de nuevo. Elige el servicio que quieres reservar.',
          collectedData: {},
          outbound: await createServiceListOutbound()
        });
      }
    }

    if (!text && !selectedId) {
      return buildMainMenuReply();
    }

    if (asksForBusinessInfo(lowerText)) {
      if (/(servicio|servicios|precio|precios)/.test(lowerText)) {
        return await buildServiceListReply(collectedData);
      }

      const services = await serviceCatalogService.listActiveServices();
      const textReply = await openAIService.answerFaq(text, services);
      return buildReply({ intent: 'faq', step: 'answered', text: textReply, collectedData });
    }

    if (conversation.currentStep === 'awaiting_name' && looksLikeName(text)) {
      await clientService.updateClient(client.id, { name: text.trim() });
      return buildReply({
        intent: 'booking',
        step: 'awaiting_formal_id',
        text: 'Gracias. Ahora necesito tu RUT o identificador para dejar la reserva registrada.',
        collectedData
      });
    }

    if ((conversation.currentStep === 'awaiting_formal_id' || !client.formalId) && looksLikeFormalId(text)) {
      await clientService.updateClient(client.id, { formalId: text.trim() });
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: 'Perfecto. Ya tengo tus datos. Elige el servicio que quieres reservar.',
        collectedData,
        outbound: await createServiceListOutbound()
      });
    }

    if (conversation.currentStep === 'awaiting_service' || matchedService || selectedAction?.type === 'service') {
      if (!matchedService) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_service',
          text: 'Elige uno de nuestros servicios disponibles.',
          collectedData,
          outbound: await createServiceListOutbound()
        });
      }

      return buildReply({
        intent: 'booking',
        step: 'awaiting_date',
        text: `Excelente, agendemos ${matchedService.name}. Indica la fecha que prefieres en formato YYYY-MM-DD.`,
        collectedData: {
          ...collectedData,
          serviceId: matchedService.id
        }
      });
    }

    if (conversation.currentStep === 'awaiting_date' || looksLikeDate(lowerText)) {
      const serviceId = collectedData.serviceId;
      if (!serviceId) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_service',
          text: 'Antes de buscar horarios necesito saber que servicio quieres reservar.',
          collectedData,
          outbound: await createServiceListOutbound()
        });
      }

      const normalizedDate = normalizeDateInput(text);
      if (!looksLikeDate(normalizedDate) || !dayjs(normalizedDate).isValid()) {
        return buildReply({
          intent: 'booking',
          step: 'awaiting_date',
          text: 'Necesito la fecha en formato YYYY-MM-DD, por ejemplo 2026-04-12.',
          collectedData
        });
      }

      const quote = await bookingService.quoteAvailability({
        serviceId,
        date: normalizedDate
      });

      const slotRows = quote.slots.slice(0, 10).map((slot) => ({
        id: `slot:${normalizeSlotValue(slot.startsAt)}`,
        title: dayjs(slot.startsAt).format('HH:mm'),
        description: `${quote.service.name} - ${quote.service.durationMinutes} min`
      }));

      return buildReply({
        intent: 'booking',
        step: 'awaiting_time',
        text: `Estos son algunos horarios disponibles para ${quote.service.name} el ${normalizedDate}. Elige una hora de la lista.`,
        collectedData: {
          ...collectedData,
          date: normalizedDate
        },
        outbound: {
          kind: 'list',
          bodyText: `Horarios disponibles para ${quote.service.name} el ${normalizedDate}`,
          buttonText: 'Ver horarios',
          sections: [
            {
              title: 'Horas disponibles',
              rows: slotRows
            }
          ]
        }
      });
    }

    if (conversation.currentStep === 'awaiting_time' || looksLikeTime(lowerText)) {
      return await confirmBookingTime({
        client,
        collectedData,
        selectedValue: text.trim()
      });
    }

    if (resolvedIntent === 'faq') {
      const services = await serviceCatalogService.listActiveServices();
      const textReply = await openAIService.answerFaq(text, services);
      return buildReply({ intent: 'faq', step: 'answered', text: textReply, collectedData });
    }

    if (resolvedIntent === 'booking') {
      return await startBookingFlow(client, collectedData);
    }

    return buildMainMenuReply();
  }

  async function startBookingFlow(client, collectedData) {
    const missingFields = [];
    if (!client.name) {
      missingFields.push('tu nombre');
    }
    if (!client.formalId) {
      missingFields.push('tu RUT o identificador');
    }

    const nextStep = !client.name ? 'awaiting_name' : (!client.formalId ? 'awaiting_formal_id' : 'awaiting_service');
    if (missingFields.length) {
      return buildReply({
        intent: 'booking',
        step: nextStep,
        text: `Para ayudarte con la reserva necesito ${missingFields.join(' y ')}.`,
        collectedData
      });
    }

    return buildReply({
      intent: 'booking',
      step: 'awaiting_service',
      text: 'Perfecto. Elige el servicio que quieres reservar.',
      collectedData,
      outbound: await createServiceListOutbound()
    });
  }

  async function buildFaqReply(topic, collectedData) {
    const services = await serviceCatalogService.listActiveServices();
    const textByTopic = {
      horarios: 'horarios',
      ubicacion: 'donde estan ubicados',
      servicios: 'que servicios ofrecen',
      contacto: 'cual es el telefono de contacto',
      politicas: 'cual es la politica de cancelacion',
      instagram: 'cuales son sus redes sociales'
    };
    const textReply = await openAIService.answerFaq(textByTopic[topic] || topic, services);
    return buildReply({ intent: 'faq', step: 'answered', text: textReply, collectedData });
  }

  async function buildServiceListReply(collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_service',
      text: 'Estos son nuestros servicios disponibles. Elige uno para continuar.',
      collectedData,
      outbound: await createServiceListOutbound()
    });
  }

  async function createServiceListOutbound() {
    const services = await serviceCatalogService.listActiveServices();
    return {
      kind: 'list',
      bodyText: 'Selecciona el servicio que quieres reservar',
      buttonText: 'Ver servicios',
      sections: [
        {
          title: 'Servicios del spa',
          rows: services.slice(0, 10).map((service) => ({
            id: `service:${service.id}`,
            title: service.name,
            description: `${service.durationMinutes} min - ${service.price} ${service.currency}`
          }))
        }
      ]
    };
  }

  async function confirmBookingTime({ client, collectedData, selectedValue }) {
    const serviceId = collectedData.serviceId;
    const date = collectedData.date;

    if (!serviceId || !date) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: 'Se perdio el contexto de la reserva. Partamos de nuevo eligiendo un servicio.',
        collectedData: {},
        outbound: await createServiceListOutbound()
      });
    }

    const normalizedTime = normalizeTimeInput(selectedValue);
    if (!looksLikeTime(normalizedTime)) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_time',
        text: 'Necesito la hora en formato HH:mm o que la elijas desde la lista.',
        collectedData
      });
    }

    const requestedDateTime = `${date}T${normalizedTime}:00-04:00`;
    const booking = await bookingService.createBooking({
      clientId: client.id,
      serviceId,
      scheduledAt: requestedDateTime
    });
    const paymentLink = await bookingService.ensurePaymentLink(booking.id);
    const craftedMessage = await openAIService.craftBookingReply({
      fallbackMessage: `Tu reserva para ${booking.service.name} quedo confirmada para el ${dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')}. Link de pago: ${paymentLink.url}`,
      bookingId: booking.id,
      serviceName: booking.service.name,
      scheduledAt: booking.scheduledAt,
      paymentLink: paymentLink.url
    });

    return buildReply({
      intent: 'booking',
      step: 'completed',
      text: craftedMessage,
      collectedData: {},
      lastBookingId: booking.id,
      outbound: {
        kind: 'buttons',
        bodyText: `${craftedMessage}\n\n¿Quieres hacer otra gestion?`,
        buttons: [
          { id: 'confirm:restart', title: 'Nueva reserva' },
          { id: 'faq:horarios', title: 'Horarios' },
          { id: 'faq:ubicacion', title: 'Ubicacion' }
        ]
      }
    });
  }

  function buildMainMenuReply() {
    return buildReply({
      intent: 'menu',
      step: 'main_menu',
      text: 'Spa Ikigai Ovalle - Menu Principal',
      collectedData: {},
      outbound: {
        kind: 'list',
        bodyText: '🌟 Spa Ikigai Ovalle - Menu Principal 🌟\n\n✨ ¿En que puedo ayudarle hoy?\n\nSeleccione una opcion del menu. Si en algun momento desea regresar aqui, puede escribir "volver".',
        buttonText: 'Abrir menu',
        sections: [
          {
            title: 'Opciones principales',
            rows: [
              { id: 'menu:services', title: 'Ver servicios', description: 'Conozca nuestros tratamientos de bienestar' },
              { id: 'menu:book', title: 'Reservar cita', description: 'Agende su momento de relax' },
              { id: 'faq:contacto', title: 'Consultas', description: 'Preguntas sobre servicios, precios o informacion' },
              { id: 'menu:manage', title: 'Gestionar reservas', description: 'Ver, cancelar o reagendar sus citas' },
              { id: 'menu:exit', title: 'Salir', description: 'Cerrar la conversacion por ahora' }
            ]
          }
        ]
      }
    });
  }

  return {
    handleIncomingMessage
  };
}

function buildReply({ intent, step, text, collectedData, lastBookingId, outbound }) {
  return {
    intent,
    step,
    text,
    collectedData,
    lastBookingId,
    outbound
  };
}

function normalizeCollectedData(value) {
  return value && typeof value === 'object' ? value : {};
}

function looksLikeName(text) {
  return /^[a-zA-ZáéíóúÁÉÍÓÚñÑ ]{3,}$/.test(text.trim());
}

function looksLikeFormalId(text) {
  return /^[0-9kK.\-]{6,15}$/.test(text.trim());
}

function looksLikeDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}

function looksLikeTime(text) {
  return /^\d{2}:\d{2}$/.test(text.trim());
}

function normalizeDateInput(text) {
  return String(text || '').trim().split(/\s+/)[0];
}

function normalizeTimeInput(text) {
  return String(text || '').trim().slice(0, 5);
}

function parseSelectedAction(selectedId) {
  if (!selectedId || !selectedId.includes(':')) {
    return null;
  }

  const [type, ...rest] = selectedId.split(':');
  return {
    type,
    value: rest.join(':')
  };
}

async function resolveServiceSelection({ selectedAction, text, serviceCatalogService }) {
  if (selectedAction?.type === 'service') {
    return serviceCatalogService.getServiceById(selectedAction.value);
  }

  return serviceCatalogService.findServiceFromText(text);
}

function inferDeterministicIntent(text, matchedService, selectedAction) {
  if (matchedService || selectedAction?.type === 'service' || selectedAction?.type === 'slot') {
    return 'booking';
  }

  if (selectedAction?.type === 'faq') {
    return 'faq';
  }

  if (selectedAction?.type === 'menu' && selectedAction.value === 'book') {
    return 'booking';
  }

  if (/(reserv|agendar|agenda|hora|cita|turno)/.test(text)) {
    return 'booking';
  }

  if (/(cancel|anular)/.test(text)) {
    return 'cancel_booking';
  }

  if (/(reagend|reprogram|cambiar hora|mover)/.test(text)) {
    return 'reschedule_booking';
  }

  if (asksForBusinessInfo(text)) {
    return 'faq';
  }

  return null;
}

function asksForBusinessInfo(text) {
  return /(horario|ubicacion|ubicación|direccion|dirección|donde|dónde|precio|precios|servicio|servicios|nombre|spa|instagram|telefono|teléfono|redes|estacionamiento|pago|tarjeta)/.test(text);
}

function wantsMainMenu(text) {
  return /^(volver|menu|menú|inicio|principal|0|salir)$/.test(String(text || '').trim().toLowerCase());
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

function normalizeSlotValue(startsAt) {
  return dayjs(startsAt).format('HH:mm');
}

function buildUserFacingErrorMessage(error) {
  if (error instanceof AppError) {
    return error.message;
  }

  return 'Ocurrio un problema procesando tu solicitud. ¿Quieres que lo intentemos de nuevo?';
}

module.exports = { createChatOrchestrator };
