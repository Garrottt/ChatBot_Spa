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

function buildDateListOutbound(bodyText = 'Elija el dia que prefiera para su cita.') {
  const rows = [];
  let cursor = dayjs();

  while (rows.length < 7) {
    if (cursor.day() !== 0) {
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
    bodyText,
    buttonText: 'Ver fechas',
    sections: [{ title: 'Proximas fechas', rows }]
  };
}

function buildUnavailableServiceOutbound(serviceName) {
  return {
    kind: 'buttons',
    bodyText: `Por el momento ${serviceName} no tiene un especialista asignado, por lo tanto no se encuentra disponible.\n\nPor favor elija otro servicio para continuar.`,
    buttons: [
      { id: 'menu:book', title: 'Otro servicio' },
      { id: 'menu:main', title: 'Volver' }
    ]
  };
}

function buildNoSlotsOutbound(serviceName, bodyText) {
  return {
    kind: 'buttons',
    bodyText,
    buttons: [
      { id: `retrydates:${serviceName}`, title: 'Ver fechas' },
      { id: 'menu:book', title: 'Otro servicio' }
    ]
  };
}

function parseSlotSelection(value) {
  const parts = String(value || '').split(':');

  return {
    time: parts.length >= 2 ? `${parts[0]}:${parts[1]}` : String(value || ''),
    specialistId: parts.length >= 3 ? parts.slice(2).join(':') : null
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
      text: 'Perfecto, vamos a agendar su cita.\n\nSeleccione el servicio que desea reservar.',
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
        text: `Excelente eleccion.\n\nAntes de buscar horarios para ${matchedService.name}, necesito su nombre y apellidos completos.`,
        collectedData: nextCollectedData
      });
    }

    if (!client.formalId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_formal_id',
        text: 'Excelente.\n\nAhora necesito su RUT o identificador para completar su perfil y mostrarle horarios disponibles.',
        collectedData: nextCollectedData
      });
    }

    return buildReply({
      intent: 'booking',
      step: 'awaiting_date',
      text: `Vamos a agendar su cita de ${matchedService.name}.\n\nSeleccione el dia que prefiera desde la lista.`,
      collectedData: nextCollectedData,
      outbound: buildDateListOutbound()
    });
  }

  async function buildDateReply({ serviceId, text, collectedData }) {
    if (!serviceId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: 'No pude recuperar el servicio seleccionado.\n\nElija nuevamente el servicio que desea reservar y continuamos.',
        collectedData,
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const normalizedDate = normalizeDateInput(text);
    if (!looksLikeDate(normalizedDate) || !dayjs(normalizedDate).isValid()) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_date',
        text: 'Para continuar, seleccione el dia directamente desde la lista.',
        collectedData,
        outbound: buildDateListOutbound()
      });
    }

    const quote = await bookingService.quoteAvailability({
      serviceId,
      date: normalizedDate
    });

    if (quote.unavailableReason === 'NO_SPECIALISTS') {
      const unavailableText = `Por el momento ${quote.service.name} no tiene un especialista asignado, por lo tanto no se encuentra disponible.\n\nPor favor elija otro servicio para continuar.`;
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: unavailableText,
        collectedData: {},
        outbound: buildUnavailableServiceOutbound(quote.service.name)
      });
    }

    const slotRows = quote.slots.slice(0, 10).map((slot) => ({
      id: ['slot', normalizeSlotValue(slot.startsAt), slot.specialistId].filter(Boolean).join(':'),
      title: dayjs(slot.startsAt).format('HH:mm'),
      description: `${quote.service.name} - ${quote.service.durationMinutes} min`
    }));

    if (!slotRows.length) {
      const isToday = normalizedDate === dayjs().format('YYYY-MM-DD');
      const noSlotsText = isToday
        ? `Hoy ya no quedan horarios disponibles para ${quote.service.name}.\n\nPor favor seleccione otra fecha.`
        : `No hay horarios disponibles para ${quote.service.name} en esa fecha.\n\nElija otro dia y buscamos uno que le acomode.`;

      return buildReply({
        intent: 'booking',
        step: 'awaiting_date',
        text: noSlotsText,
        collectedData: {
          ...collectedData,
          serviceId
        },
        outbound: buildNoSlotsOutbound(
          quote.service.name,
          `${noSlotsText}\n\nPuede revisar otras fechas o cambiar de servicio.`
        )
      });
    }

    return buildReply({
      intent: 'booking',
      step: 'awaiting_time',
      text: `Estos son los horarios disponibles para ${quote.service.name}.\n\nElija el que mas le acomode.`,
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
        text: 'No pude recuperar los datos de la reserva.\n\nVolvamos al inicio y elijamos nuevamente el servicio.',
        collectedData: {},
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const slotSelection = parseSlotSelection(selectedValue);
    const normalizedTime = normalizeTimeInput(slotSelection.time);
    if (!looksLikeTime(normalizedTime)) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_time',
        text: 'No pude reconocer ese horario.\n\nPor favor elija una hora directamente desde la lista.',
        collectedData
      });
    }

    const nextCollectedData = {
      ...collectedData,
      time: normalizedTime,
      specialistId: slotSelection.specialistId || collectedData.specialistId || null
    };

    if (!client.name || !client.lastName) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_name',
        text: 'Antes de continuar, necesito su nombre y apellidos completos.',
        collectedData: nextCollectedData
      });
    }

    if (!client.formalId) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_formal_id',
        text: 'Casi listo.\n\nSolo necesito su RUT o identificador para continuar.',
        collectedData: nextCollectedData
      });
    }

    return buildPayerRoleReply(client, nextCollectedData);
  }

  function buildDatePrompt(collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_date',
      text: 'Perfecto.\n\nSeleccione el dia de su preferencia desde la lista.',
      collectedData,
      outbound: buildDateListOutbound()
    });
  }

  function buildPayerRoleReply(client, collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_payer_role',
      text: `Ya casi terminamos.\n\nPara bloquear su horario necesitamos un abono previo de ${env.bookingDepositAmount} CLP.\n\nQuien realizara el pago del abono?`,
      collectedData: {
        ...collectedData,
        payerName: collectedData.payerName || client.name || null,
        payerLastName: collectedData.payerLastName || client.lastName || null,
        payerFormalId: collectedData.payerFormalId || client.formalId || null,
        payerEmail: collectedData.payerEmail || null
      },
      outbound: {
        kind: 'buttons',
        bodyText: `Necesitamos identificar a la persona que realizara el pago del abono de ${env.bookingDepositAmount} CLP.`,
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
    const summaryText = `Tengo estos datos guardados sobre usted:\n\nNombre: ${payerFullName}\nRUT: ${client.formalId}\n\nConfirma que estos son los datos de quien realizara el abono?`;

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
        kind: 'buttons',
        bodyText: summaryText,
        buttons: [
          { id: 'payerconfirm:self', title: 'Esos son mis datos' },
          { id: 'payeredit:self', title: 'Editar mis datos' },
          { id: 'payer:other', title: 'Otra persona' }
        ]
      }
    });
  }

  function buildPaymentMethodReply(collectedData) {
    return buildReply({
      intent: 'booking',
      step: 'awaiting_payment_method',
      text: `Para bloquear su horario necesitamos un abono de ${env.bookingDepositAmount} CLP.\n\nComo prefiere realizarlo?`,
      collectedData,
      outbound: {
        kind: 'list',
        bodyText: `Abono requerido: ${env.bookingDepositAmount} CLP.\nLuego del pago, tendra ${env.bookingHoldMinutes} minutos para enviar su comprobante.`,
        buttonText: 'Medio de pago',
        sections: [
          {
            title: 'Opciones de pago',
            rows: [
              { id: 'payment:card', title: 'Debito o credito', description: 'Pagar con link de Mercado Pago' },
              { id: 'payment:transfer', title: 'Transferencia', description: 'Recibir datos bancarios y enviar comprobante' }
            ]
          }
        ]
      }
    });
  }

  async function initiatePaymentCollection({ client, collectedData, paymentMethod }) {
    const { serviceId, date, time, specialistId } = collectedData;

    if (!serviceId || !date || !time) {
      return buildReply({
        intent: 'booking',
        step: 'awaiting_service',
        text: 'No pude recuperar los datos de la reserva.\n\nVolvamos al inicio y elijamos nuevamente el servicio.',
        collectedData: {},
        outbound: await servicesFlow.createServiceListOutbound()
      });
    }

    const booking = await bookingService.createPendingBooking({
      clientId: client.id,
      serviceId,
      scheduledAt: `${date}T${time}:00`,
      specialistId,
      paymentMethod,
      payer: {
        name: collectedData.payerName,
        lastName: collectedData.payerLastName,
        formalId: collectedData.payerFormalId,
        email: collectedData.payerEmail
      }
    });

    const paymentMethodText = paymentMethod === 'BANK_TRANSFER'
      ? buildTransferPaymentText(env.spaTransferDetails)
      : 'Aqui tiene el link para pagar el abono con debito o credito.';

    const paymentLink = paymentMethod === 'BANK_TRANSFER'
      ? null
      : await bookingService.ensurePaymentLink(booking.id);

    const paymentInstructions = paymentLink
      ? `Link de pago:\n${paymentLink.url}`
      : 'Cuando realice la transferencia, envie aqui una foto o captura del comprobante.';

    return buildReply({
      intent: 'booking',
      step: 'awaiting_payment_proof',
      text: `${paymentMethodText}\n\nMonto del abono: ${env.bookingDepositAmount} CLP\n${paymentInstructions}\n\nTiene ${env.bookingHoldMinutes} minutos para enviar el comprobante y confirmar su cita.`,
      collectedData: {
        bookingId: booking.id,
        serviceId,
        specialistId: booking.specialistId || specialistId || null,
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

function buildTransferPaymentText(transferDetails) {
  const normalizedDetails = String(transferDetails || '').trim();
  const sanitizedDetails = normalizedDetails
    .replace(/^Datos bancarios para transferir:\s*/i, '')
    .trim();

  if (!sanitizedDetails) {
    return 'Aqui estan los datos bancarios para realizar la transferencia del abono.';
  }

  return `Aqui estan los datos bancarios para realizar la transferencia del abono:\n\n${sanitizedDetails}`;
}
