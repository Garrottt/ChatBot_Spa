const dayjs = require('dayjs');

const { env } = require('../config/env');
const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');

function createBookingService({ prisma, googleCalendar, paymentProvider, serviceCatalogService }) {
  async function quoteAvailability({ serviceId, date }) {
    const normalizedDate = String(date || '').trim();
    if (!looksLikeIsoDate(normalizedDate) || !dayjs(normalizedDate).isValid()) {
      throw new AppError('La fecha debe venir en formato YYYY-MM-DD.', 400);
    }

    if (dayjs(normalizedDate).endOf('day').isBefore(dayjs())) {
      throw new AppError('No es posible reservar fechas pasadas.', 400);
    }

    await expirePendingBookings();

    const service = await serviceCatalogService.getServiceById(serviceId);
    const specialists = await findActiveSpecialistsForService(service.id);

    if (!specialists.length) {
      logger.warn('Service has no active specialists assigned for booking', {
        serviceId: service.id,
        serviceName: service.name
      });

      return {
        service: {
          id: service.id,
          name: service.name,
          durationMinutes: service.durationMinutes,
          price: service.price,
          currency: service.currency
        },
        slots: [],
        unavailableReason: 'NO_SPECIALISTS'
      };
    }

    const specialistSlots = await buildSpecialistAvailabilitySlots({
      service,
      date: normalizedDate,
      specialists
    });
    const now = dayjs();
    const availableSlots = specialistSlots.filter((slot) => {
      const slotStart = dayjs(slot.startsAt);

      if (!slotStart.isAfter(now)) {
        return false;
      }

      return true;
    });

    return {
      service: {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        price: service.price,
        currency: service.currency
      },
      slots: availableSlots,
      unavailableReason: null
    };
  }

  async function createBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer, specialistId }) {
    return createPendingBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer, specialistId });
  }

  async function createPendingBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer, specialistId }) {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new AppError('Client not found', 404);
    }

    if (!client.name || !client.lastName || !client.formalId) {
      throw new AppError('Client must include name, last name and formal ID before creating a booking', 400);
    }

    const payerData = normalizePayerData(payer, client);
    if (!payerData.name || !payerData.lastName || !payerData.formalId) {
      throw new AppError('Payer must include name, last name and formal ID before creating a booking', 400);
    }

    const service = await serviceCatalogService.getServiceById(serviceId);
    const startAt = dayjs(scheduledAt);

    if (!startAt.isValid()) {
      throw new AppError('Invalid booking datetime', 400);
    }

    if (startAt.isBefore(dayjs())) {
      throw new AppError('No es posible reservar en una fecha u hora pasada.', 400);
    }

    await expirePendingBookings();

    const endAt = startAt.add(service.durationMinutes, 'minute');
    const assignedSpecialistId = await resolveAvailableSpecialistForSlot({
      service,
      preferredSpecialistId: specialistId,
      startAt,
      endAt
    });

    const activeHold = await prisma.booking.findFirst({
      where: {
        clientId,
        serviceId,
        specialistId: assignedSpecialistId,
        status: 'PENDING',
        scheduledAt: startAt.toDate(),
        holdExpiresAt: { gt: new Date() }
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });

    if (activeHold) {
      return prisma.booking.update({
        where: { id: activeHold.id },
        data: {
          paymentMethod,
          payerName: payerData.name,
          payerLastName: payerData.lastName,
          payerFormalId: payerData.formalId,
          payerEmail: payerData.email,
          paymentStatus: 'PENDING',
          paymentProofStatus: 'PENDING',
          paymentProofReceivedAt: null,
          paymentProofMetadata: null,
          paymentProofValidation: null,
          holdExpiresAt: dayjs().add(env.bookingHoldMinutes, 'minute').toDate(),
          depositAmount: env.bookingDepositAmount,
          specialistId: assignedSpecialistId,
          notes: notes || activeHold.notes || null
        },
        include: {
          client: true,
          service: true,
          paymentLink: true
        }
      });
    }

    const existingOverlap = await findOverlappingBooking({
      serviceId,
      specialistId: assignedSpecialistId,
      startAt: startAt.toDate(),
      endAt: endAt.toDate()
    });

    if (existingOverlap) {
      throw new AppError('Selected slot is no longer available', 409);
    }

    return prisma.booking.create({
        data: {
          clientId,
          serviceId,
          payerName: payerData.name,
          payerLastName: payerData.lastName,
          payerFormalId: payerData.formalId,
          payerEmail: payerData.email,
          scheduledAt: startAt.toDate(),
        specialistId: assignedSpecialistId,
        endAt: endAt.toDate(),
        notes: notes || null,
        status: 'PENDING',
        paymentMethod,
        paymentStatus: 'PENDING',
        paymentProofStatus: 'PENDING',
        holdExpiresAt: dayjs().add(env.bookingHoldMinutes, 'minute').toDate(),
        depositAmount: env.bookingDepositAmount
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function recordPaymentProofSubmission(bookingId, proofMetadata) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    ensurePendingBookingIsValidOrThrow(booking);

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: 'PROOF_SUBMITTED',
        paymentProofReceivedAt: new Date(),
        paymentProofMetadata: proofMetadata
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function rejectPaymentProof(bookingId, { proofMetadata, validation }) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    ensurePendingBookingIsValidOrThrow(booking);

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: 'REJECTED',
        paymentProofStatus: 'INVALID',
        paymentProofReceivedAt: new Date(),
        paymentProofMetadata: proofMetadata,
        paymentProofValidation: validation
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function confirmPendingBooking(bookingId, { proofMetadata, validation }) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    ensurePendingBookingIsValidOrThrow(booking);

    const event = await googleCalendar.createEvent({
      calendarId: booking.service.calendarId,
      booking,
      client: booking.client,
      service: booking.service
    });

    logger.info('Created Google Calendar event for booking', {
      bookingId: booking.id,
      calendarEventId: event.id,
      serviceName: booking.service.name,
      scheduledAt: booking.scheduledAt.toISOString(),
      calendarId: booking.service.calendarId || env.googleDefaultCalendarId
    });

    await prisma.paymentLink.updateMany({
      where: { bookingId },
      data: { status: 'APPROVED' }
    });

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CONFIRMED',
        paymentStatus: 'APPROVED',
        paymentProofStatus: 'VALID',
        paymentProofReceivedAt: new Date(),
        paymentProofMetadata: proofMetadata,
        paymentProofValidation: validation,
        holdExpiresAt: null,
        calendarEventId: event.id
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function getBookingById(bookingId) {
    return prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function cancelBooking(bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.status === 'CANCELLED') {
      return booking;
    }

    if (booking.status === 'CONFIRMED' && booking.calendarEventId) {
      logger.info('Cancelling Google Calendar event for booking', {
        bookingId: booking.id,
        calendarEventId: booking.calendarEventId,
        calendarId: booking.service.calendarId || env.googleDefaultCalendarId
      });

      await googleCalendar.cancelEvent({
        calendarId: booking.service.calendarId,
        eventId: booking.calendarEventId
      });
    }

    await prisma.paymentLink.updateMany({
      where: { bookingId },
      data: {
        status: booking.paymentStatus === 'APPROVED' ? 'APPROVED' : 'CANCELLED'
      }
    });

    return prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        paymentStatus: booking.paymentStatus === 'APPROVED' ? booking.paymentStatus : 'EXPIRED',
        holdExpiresAt: null
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
    });
  }

  async function expirePendingBookings(referenceDate = new Date()) {
    const now = new Date(referenceDate);
    const result = await prisma.booking.updateMany({
      where: {
        status: 'PENDING',
        holdExpiresAt: { lte: now }
      },
      data: {
        status: 'CANCELLED',
        paymentStatus: 'EXPIRED',
        holdExpiresAt: null
      }
    });

    await prisma.paymentLink.updateMany({
      where: {
        booking: {
          status: 'CANCELLED',
          paymentStatus: 'EXPIRED'
        }
      },
      data: {
        status: 'EXPIRED'
      }
    });

    return {
      expired: result.count
    };
  }

  async function findUpcomingBookingsForClient(clientId, { limit = 5 } = {}) {
    return prisma.booking.findMany({
      where: {
        clientId,
        status: 'CONFIRMED',
        scheduledAt: { gte: new Date() }
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit
    });
  }

  async function ensurePaymentLink(bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        service: true,
        paymentLink: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.paymentLink && !shouldRefreshPaymentLink(booking.paymentLink)) {
      return booking.paymentLink;
    }

    const paymentLink = await paymentProvider.createPaymentLink({
      bookingId,
      amount: env.bookingDepositAmount,
      currency: booking.service.currency,
      description: `Abono ${booking.service.name} - ${bookingId}`
    });

    if (booking.paymentLink) {
      logger.info('Refreshing existing payment link for booking', {
        bookingId,
        previousProvider: booking.paymentLink.provider,
        nextProvider: paymentLink.provider
      });

      return prisma.paymentLink.update({
        where: { bookingId },
        data: {
          provider: paymentLink.provider,
          url: paymentLink.url,
          amount: paymentLink.amount,
          currency: paymentLink.currency,
          status: paymentLink.status
        }
      });
    }

    return prisma.paymentLink.create({
      data: {
        bookingId,
        provider: paymentLink.provider,
        url: paymentLink.url,
        amount: paymentLink.amount,
        currency: paymentLink.currency,
        status: paymentLink.status
      }
    });
  }

  async function buildSpecialistAvailabilitySlots({ service, date, specialists = null }) {
    const activeSpecialists = Array.isArray(specialists)
      ? specialists
      : await findActiveSpecialistsForService(service.id);

    if (!activeSpecialists.length) {
      logger.warn('No active specialists found for service availability', {
        serviceId: service.id,
        serviceName: service.name
      });
      return [];
    }

    const dayOfWeek = getChileDayOfWeek(date);
    const dayStart = buildChileDateTime(date, '00:00').toDate();
    const dayEnd = buildChileDateTime(date, '23:59').toDate();
    const slots = [];

    for (const specialist of activeSpecialists) {
      const availabilities = (specialist.availabilities || []).filter((availability) =>
        Number(availability.dayOfWeek) === dayOfWeek
      );

      if (!availabilities.length) {
        continue;
      }

      const blockingBookings = await findBlockingBookings({
        serviceId: service.id,
        specialistId: specialist.id,
        dayStart,
        dayEnd
      });

      for (const availability of availabilities) {
        slots.push(...buildSlotsForAvailability({
          date,
          durationMinutes: service.durationMinutes,
          specialist,
          availability,
          blockingBookings
        }));
      }
    }

    return slots
      .sort((left, right) => dayjs(left.startsAt).valueOf() - dayjs(right.startsAt).valueOf())
      .filter((slot, index, allSlots) =>
        index === allSlots.findIndex((candidate) => candidate.startsAt === slot.startsAt)
      );
  }

  async function findActiveSpecialistsForService(serviceId) {
    return prisma.specialist.findMany({
      where: {
        active: true,
        serviceLinks: {
          some: { serviceId }
        }
      },
      include: {
        availabilities: true
      },
      orderBy: { name: 'asc' }
    });
  }

  async function resolveAvailableSpecialistForSlot({ service, preferredSpecialistId, startAt, endAt }) {
    const specialists = await findActiveSpecialistsForService(service.id);
    const orderedSpecialists = preferredSpecialistId
      ? [
          ...specialists.filter((specialist) => specialist.id === preferredSpecialistId),
          ...specialists.filter((specialist) => specialist.id !== preferredSpecialistId)
        ]
      : specialists;

    for (const specialist of orderedSpecialists) {
      const availabilityMatches = hasAvailabilityForSlot({
        specialist,
        startAt,
        endAt
      });

      if (!availabilityMatches) {
        continue;
      }

      const overlappingBooking = await findOverlappingBooking({
        serviceId: service.id,
        specialistId: specialist.id,
        startAt: startAt.toDate(),
        endAt: endAt.toDate()
      });

      if (!overlappingBooking) {
        return specialist.id;
      }
    }

    throw new AppError('Ese horario ya no esta disponible. Por favor seleccione otra hora.', 409);
  }

  async function findBlockingBookings({ serviceId, specialistId, dayStart, dayEnd }) {
    return prisma.booking.findMany({
      where: {
        ...(specialistId ? { specialistId } : { serviceId }),
        OR: [
          { status: 'CONFIRMED' },
          {
            status: 'PENDING',
            holdExpiresAt: { gt: new Date() }
          }
        ],
        scheduledAt: { lt: dayEnd },
        endAt: { gt: dayStart }
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        endAt: true,
        holdExpiresAt: true
      }
    });
  }

  async function findOverlappingBooking({ serviceId, specialistId, startAt, endAt }) {
    return prisma.booking.findFirst({
      where: {
        ...(specialistId ? { specialistId } : { serviceId }),
        OR: [
          { status: 'CONFIRMED' },
          {
            status: 'PENDING',
            holdExpiresAt: { gt: new Date() }
          }
        ],
        scheduledAt: { lt: endAt },
        endAt: { gt: startAt }
      }
    });
  }

  async function reconcileCalendarEvents({ referenceDate = new Date(), limit = 50 } = {}) {
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        scheduledAt: { gte: new Date(referenceDate) }
      },
      include: {
        client: true,
        service: true,
        paymentLink: true
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit
    });

    let checked = 0;
    let recreated = 0;

    for (const booking of bookings) {
      checked += 1;

      let shouldCreateEvent = !booking.calendarEventId;

      if (booking.calendarEventId) {
        if (booking.calendarEventId.startsWith('dev-event-')) {
          shouldCreateEvent = true;
        } else {
          const existingEvent = await googleCalendar.getEvent({
            calendarId: booking.service.calendarId,
            eventId: booking.calendarEventId
          });

          shouldCreateEvent = !existingEvent || existingEvent.status === 'cancelled';
        }
      }

      if (!shouldCreateEvent) {
        continue;
      }

      const event = await googleCalendar.createEvent({
        calendarId: booking.service.calendarId,
        booking,
        client: booking.client,
        service: booking.service
      });

      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          calendarEventId: event.id
        }
      });

      recreated += 1;

      logger.warn('Recreated Google Calendar event for confirmed booking', {
        bookingId: booking.id,
        previousCalendarEventId: booking.calendarEventId,
        newCalendarEventId: event.id,
        scheduledAt: booking.scheduledAt.toISOString(),
        calendarId: booking.service.calendarId || env.googleDefaultCalendarId
      });
    }

    return {
      checked,
      recreated
    };
  }

  return {
    quoteAvailability,
    createBooking,
    createPendingBooking,
    recordPaymentProofSubmission,
    rejectPaymentProof,
    confirmPendingBooking,
    getBookingById,
    cancelBooking,
    expirePendingBookings,
    findUpcomingBookingsForClient,
    ensurePaymentLink,
    reconcileCalendarEvents
  };
}

function ensurePendingBookingIsValidOrThrow(booking) {
  if (booking.status === 'CONFIRMED') {
    throw new AppError('La reserva ya fue confirmada anteriormente.', 409);
  }

  if (booking.status === 'CANCELLED' || booking.paymentStatus === 'EXPIRED') {
    throw new AppError('La reserva temporal expiro y el horario fue liberado.', 410);
  }

  if (booking.status !== 'PENDING') {
    throw new AppError('La reserva no esta disponible para validar pago.', 409);
  }

  if (booking.holdExpiresAt && dayjs(booking.holdExpiresAt).isBefore(dayjs())) {
    throw new AppError('La reserva temporal expiro y el horario fue liberado.', 410);
  }
}

function buildSlotsForAvailability({ date, durationMinutes, specialist, availability, blockingBookings }) {
  const slots = [];
  let cursor = buildChileDateTime(date, formatTimeValue(availability.startTime));
  const availabilityEnd = buildChileDateTime(date, formatTimeValue(availability.endTime));

  while (cursor.add(durationMinutes, 'minute').valueOf() <= availabilityEnd.valueOf()) {
    const slotStart = cursor;
    const slotEnd = cursor.add(durationMinutes, 'minute');
    const isBlocked = blockingBookings.some((booking) =>
      dayjs(booking.scheduledAt).isBefore(slotEnd) &&
      dayjs(booking.endAt).isAfter(slotStart)
    );

    if (!isBlocked) {
      slots.push({
        startsAt: slotStart.format('YYYY-MM-DDTHH:mm:ss'),
        endsAt: slotEnd.format('YYYY-MM-DDTHH:mm:ss'),
        specialistId: specialist.id,
        specialistName: specialist.name
      });
    }

    cursor = slotEnd;
  }

  return slots;
}

function hasAvailabilityForSlot({ specialist, startAt, endAt }) {
  const dayOfWeek = startAt.day();
  return (specialist.availabilities || []).some((availability) => {
    if (Number(availability.dayOfWeek) !== dayOfWeek) {
      return false;
    }

    const date = startAt.format('YYYY-MM-DD');
    const availabilityStart = buildChileDateTime(date, formatTimeValue(availability.startTime));
    const availabilityEnd = buildChileDateTime(date, formatTimeValue(availability.endTime));

    return !startAt.isBefore(availabilityStart) && !endAt.isAfter(availabilityEnd);
  });
}

function getChileDayOfWeek(date) {
  return buildChileDateTime(date, '12:00').day();
}

function buildChileDateTime(date, time) {
  return dayjs(`${date}T${time}:00`);
}

function formatTimeValue(value) {
  if (value instanceof Date) {
    return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`;
  }

  const normalized = String(value || '').trim();
  const match = normalized.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '00:00';
}

function looksLikeIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizePayerData(payer, client) {
  return {
    name: payer?.name || client.name || null,
    lastName: payer?.lastName || client.lastName || null,
    formalId: payer?.formalId || client.formalId || null,
    email: payer?.email || null
  };
}

function shouldRefreshPaymentLink(paymentLink) {
  if (!paymentLink?.url) {
    return true;
  }

  if (paymentLink.status === 'EXPIRED' || paymentLink.status === 'CANCELLED') {
    return true;
  }

  if (env.mercadoPagoAccessToken && paymentLink.provider !== 'mercadopago') {
    return true;
  }

  return false;
}

module.exports = { createBookingService };
