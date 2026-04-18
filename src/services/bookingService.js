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
    const slots = await googleCalendar.getAvailableSlots({
      calendarId: service.calendarId,
      date: normalizedDate,
      durationMinutes: service.durationMinutes
    });

    const blockingBookings = await findBlockingBookings({
      serviceId,
      dayStart: dayjs(normalizedDate).startOf('day').toDate(),
      dayEnd: dayjs(normalizedDate).endOf('day').toDate()
    });

    const now = dayjs();
    const availableSlots = slots.filter((slot) => {
      const slotStart = dayjs(slot.startsAt);
      const slotEnd = dayjs(slot.endsAt || slot.startsAt).isValid()
        ? dayjs(slot.endsAt || slot.startsAt)
        : slotStart.add(service.durationMinutes, 'minute');

      // Excluir slots que ya comenzaron o que ya pasaron
      if (!slotStart.isAfter(now)) {
        return false;
      }

      return !blockingBookings.some((booking) =>
        dayjs(booking.scheduledAt).isBefore(slotEnd) &&
        dayjs(booking.endAt).isAfter(slotStart)
      );
    });

    return {
      service: {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        price: service.price,
        currency: service.currency
      },
      slots: availableSlots
    };
  }

  async function createBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer }) {
    return createPendingBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer });
  }

  async function createPendingBooking({ clientId, serviceId, scheduledAt, notes, paymentMethod, payer }) {
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
    const activeHold = await prisma.booking.findFirst({
      where: {
        clientId,
        serviceId,
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

    if (booking.paymentLink) {
      return booking.paymentLink;
    }

    const paymentLink = await paymentProvider.createPaymentLink({
      bookingId,
      amount: env.bookingDepositAmount,
      currency: booking.service.currency,
      description: `Abono ${booking.service.name} - ${bookingId}`
    });

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

  async function findBlockingBookings({ serviceId, dayStart, dayEnd }) {
    return prisma.booking.findMany({
      where: {
        serviceId,
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

  async function findOverlappingBooking({ serviceId, startAt, endAt }) {
    return prisma.booking.findFirst({
      where: {
        serviceId,
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
        const existingEvent = await googleCalendar.getEvent({
          calendarId: booking.service.calendarId,
          eventId: booking.calendarEventId
        });

        shouldCreateEvent = !existingEvent || existingEvent.status === 'cancelled';
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

module.exports = { createBookingService };
