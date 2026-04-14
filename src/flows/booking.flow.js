const dayjs = require('dayjs');

const { env } = require('../config/env');
const {
  buildReply,
  looksLikeDate,
  looksLikeTime,
  normalizeDateInput,
  normalizeSlotValue,
  normalizeTimeInput
} = require('./helpers');

const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function buildDateListOutbound() {
  const rows = [];
  let cursor = dayjs();

  while (rows.length < 7) {
    if (cursor.day() !== 0) { // Excluir domingos (0 = domingo)
      const label = `${DAYS_ES[cursor.day()]} ${cursor.date()} ${MONTHS_ES[cursor.month()]}`;
      rows.push({
        id: `date:${cursor.format('YYYY-MM-DD')}`,
        title: label.slice(0, 24),
        description: cursor.format('YYYY-MM-DD')
      });
    }
    cursor = cursor.add(1, 'day');
  }

  return {
    kind: 'list',
    bodyText: '📅 Seleccione el dia de su preferencia para la cita.',
    buttonText: 'Ver fechas disponibles',
    sections: [{ title: 'Proximas fechas', rows }]
  };
}

function createBookingFlow({
  bookingService,
  servicesFlow
}) {
  async function startBookingFlow(_client, collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_service',
      text: '✨ ¡Con gusto! Seleccione el servicio que desea reservar.',
      collectedData,
      outbound: await servicesFlow.createServiceListOutbound()
    });
  }

  function buildServiceSelectionReply(client, matchedService, collectedData) {
    const nextCollectedData = {
      ...collectedData,
      serviceId: matchedService.id
    };

    if (!client.name || !client.lastName) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_name',
        text: `💆 ¡Excelente eleccion! Antes de buscar los horarios disponibles para *${matchedService.name}*, necesito su nombre y apellidos completos.`,
        collectedData: nextCollectedData
      });
    }

    if (!client.formalId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_formal_id',
        text: `💆 ¡Excelente eleccion! Solo necesito su RUT o identificador para completar su perfil y ofrecerle los horarios disponibles.`,
        collectedData: nextCollectedData
      });
    }

    return buildReply({
      intent: 'booking',
      step: 'awaiting_date',
      text: `💆 ¡Perfecto! Agendemos su cita de *${matchedService.name}*. ¿Que dia le viene mejor?`,
      collectedData: nextCollectedData,
      outbound: buildDateListOutbound()
    });
  }

  async function buildDateReply({ serviceId, text, collectedData }) {
    if (!serviceId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: '😅 Perdi el contexto del servicio. Elija el servicio que desea reservar y comenzamos de nuevo.',
        collectedData,
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const normalizedDate = normalizeDateInput(text);
    if (!looksLikeDate(normalizedDate) || !dayjs(normalizedDate).isValid()) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_date',
        text: '⚠️ La fecha seleccionada no es valida. Por favor elija una opcion directamente desde la lista.',
        collectedData,
        outbound: buildDateListOutbound()
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

    if (!slotRows.length) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_date',
        text: `😔 No hay horarios disponibles para *${quote.service.name}* en esa fecha. Elija otro dia y buscamos uno que le acomode.`,
        collectedData: {
          ...collectedData,
          serviceId
        },
        outbound: buildDateListOutbound()
      });
    }

    return buildReply({
      intent: 'booking',
      step: 'awaiting_time',
      text: `🕐 Aqui estan los horarios disponibles para *${quote.service.name}*. Elija el que mas le acomode.`,
      collectedData: {
        ...collectedData,
        date: normalizedDate,
        serviceId
      },
      outbound: {
        kind: 'list',
        bodyText: `Horarios disponibles para ${quote.service.name}`,
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

  async function confirmBookingTime({ client, collectedData, selectedValue }) {
    const serviceId = collectedData.serviceId;
    const date = collectedData.date;

    if (!serviceId || !date) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: '😅 Se perdio el contexto de la reserva. Volvamos al inicio y elegimos el servicio.',
        collectedData: {},
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const normalizedTime = normalizeTimeInput(selectedValue);
    if (!looksLikeTime(normalizedTime)) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_time',
        text: '⚠️ No pude reconocer ese horario. Por favor elija una hora directamente desde la lista.',
        collectedData
      });
    }

    const nextCollectedData = {
      ...collectedData,
      time: normalizedTime
    };

    if (!client.name || !client.lastName) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_name',
        text: '📝 Antes de continuar con la reserva, necesito su nombre y apellidos completos.',
        collectedData: nextCollectedData
      });
    }

    if (!client.formalId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_formal_id',
        text: '📝 ¡Casi listo! Solo necesito su RUT o identificador para continuar.',
        collectedData: nextCollectedData
      });
    }

    return buildPayerRoleReply(client, nextCollectedData);
  }

  function buildDatePrompt(collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_date',
      text: '📅 ¡Perfecto! ¿Que dia prefiere para su cita?',
      collectedData,
      outbound: buildDateListOutbound()
    });
  }

  function buildPayerRoleReply(client, collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_payer_role',
      text: `💳 ¡Genial! Ya casi terminamos. Para reservar y bloquear su horario necesitamos un abono previo de *${env.bookingDepositAmount} CLP*.\n\n¿Quien realizara la transferencia del abono?`,
      collectedData: {
        ...collectedData,
        payerName: collectedData.payerName || client.name || null,
        payerLastName: collectedData.payerLastName || client.lastName || null,
        payerFormalId: collectedData.payerFormalId || client.formalId || null,
        payerEmail: collectedData.payerEmail || null
      },
      outbound: {
        kind: 'buttons',
        bodyText: `Necesitamos identificar al pagador del abono (${env.bookingDepositAmount} CLP) para validar correctamente el comprobante de transferencia.`,
        buttons: [
          { id: 'payer:self', title: 'Yo hare el pago' },
          { id: 'payer:other', title: 'Otra persona' },
          { id: 'menu:main', title: 'Volver' }
        ]
      }
    });
  }

  function buildPayerSummaryReply(client, collectedData) {
    const payerFullName = [client.name, client.lastName].filter(Boolean).join(' ').trim();
    const summaryText = `👤 Estos son los datos que tenemos registrados:\n\n*Nombre:* ${payerFullName}\n*RUT:* ${client.formalId}\n\n¿Son estos los datos de quien realizara el abono?`;
    return buildReply({
      intent: 'booking',
      step: 'awaiting_payer_confirmation',
      text: summaryText,
      collectedData: {
        ...collectedData,
        payerName: client.name,
        payerLastName: client.lastName,
        payerFormalId: client.formalId,
        payerEmail: collectedData.payerEmail || null
      },
      outbound: {
        kind: 'list',
        bodyText: summaryText,
        buttonText: 'Opciones',
        sections: [
          {
            title: 'Confirmar datos del pagador',
            rows: [
              { id: 'payerconfirm:self', title: 'Esos son mis datos', description: 'Confirmar y continuar con el pago' },
              { id: 'payeredit:self', title: 'Editar mis datos', description: 'Corregir nombre o RUT registrado' },
              { id: 'payer:other', title: 'Otra persona pagara', description: 'Ingresar datos de otro pagador' },
              { id: 'menu:main', title: 'Volver al menu', description: '' }
            ]
          }
        ]
      }
    });
  }

  function buildPaymentMethodReply(collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_payment_method',
      text: `💳 Para bloquear su horario necesitamos un abono de *${env.bookingDepositAmount} CLP*. ¿Como prefiere realizarlo?`,
      collectedData,
      outbound: {
        kind: 'buttons',
        bodyText: `Abono requerido: ${env.bookingDepositAmount} CLP\nTiene ${env.bookingHoldMinutes} minutos para enviar el comprobante una vez realizado el pago.`,
        buttons: [
          { id: 'payment:card', title: 'Debito o credito' },
          { id: 'payment:transfer', title: 'Transferencia' }
        ]
      }
    });
  }

  async function initiatePaymentCollection({ client, collectedData, paymentMethod }) {
    const { serviceId, date, time } = collectedData;

    if (!serviceId || !date || !time) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: '😅 Se perdio el contexto de la reserva. Volvamos al inicio y elegimos el servicio.',
        collectedData: {},
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const booking = await bookingService.createPendingBooking({
      clientId: client.id,
      serviceId,
      scheduledAt: `${date}T${time}:00`,
      paymentMethod,
      payer: {
        name: collectedData.payerName,
        lastName: collectedData.payerLastName,
        formalId: collectedData.payerFormalId,
        email: collectedData.payerEmail
      }
    });

    const paymentMethodText = paymentMethod === 'BANK_TRANSFER'
      ? `🏦 Aqui estan los datos bancarios para realizar la transferencia del abono:\n\n${env.spaTransferDetails}`
      : '💳 Aqui tiene el link para pagar el abono con debito o credito.';

    const paymentLink = paymentMethod === 'BANK_TRANSFER'
      ? null
      : await bookingService.ensurePaymentLink(booking.id);

    const paymentInstructions = paymentLink
      ? `🔗 *Link de pago:* ${paymentLink.url}`
      : '📸 Una vez realizada la transferencia, envie una foto o captura del comprobante.';

    return buildReply({
      intent: 'booking',
      step: 'awaiting_payment_proof',
      text: `${paymentMethodText}\n\n💰 *Monto del abono:* ${env.bookingDepositAmount} CLP\n${paymentInstructions}\n\n⏱️ Tiene *${env.bookingHoldMinutes} minutos* para enviar el comprobante y confirmar su cita. ¡No se preocupe, le avisaremos cuando queden 5 minutos!`,
      collectedData: {
        bookingId: booking.id,
        serviceId,
        date,
        time,
        paymentMethod
      },
      lastBookingId: booking.id
    });
  }

  return {
    buildDateReply,
    buildDatePrompt,
    buildPayerRoleReply,
    buildPayerSummaryReply,
    buildPaymentMethodReply,
    buildServiceSelectionReply,
    confirmBookingTime,
    initiatePaymentCollection,
    startBookingFlow
  };
}

module.exports = { createBookingFlow };
