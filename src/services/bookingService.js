const dayjs = require('dayjs');

const { AppError } = require('../lib/errors');

function createBookingService({ prisma, googleCalendar, paymentProvider, serviceCatalogService }) {
  async function quoteAvailability({ serviceId, date }) {
    const normalizedDate = String(date || '').trim();
    if (!looksLikeIsoDate(normalizedDate) || !dayjs(normalizedDate).isValid()) {
      throw new AppError('La fecha debe venir en formato YYYY-MM-DD.', 400);
    }

    const service = await serviceCatalogService.getServiceById(serviceId);
    const slots = await googleCalendar.getAvailableSlots({
      calendarId: service.calendarId,
      date: normalizedDate,
      durationMinutes: service.durationMinutes
    });

    return {
      service: {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        price: service.price,
        currency: service.currency
      },
      slots
    };
  }

  async function createBooking({ clientId, serviceId, scheduledAt, notes }) {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new AppError('Client not found', 404);
    }

    if (!client.name || !client.formalId) {
      throw new AppError('Client must include name and formal ID before confirming a booking', 400);
    }

    const service = await serviceCatalogService.getServiceById(serviceId);
    const startAt = dayjs(scheduledAt);

    if (!startAt.isValid()) {
      throw new AppError('Invalid booking datetime', 400);
    }

    const endAt = startAt.add(service.durationMinutes, 'minute');
    const existingOverlap = await prisma.booking.findFirst({
      where: {
        serviceId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        scheduledAt: { lt: endAt.toDate() },
        endAt: { gt: startAt.toDate() }
      }
    });

    if (existingOverlap) {
      throw new AppError('Selected slot is no longer available', 409);
    }

    const booking = await prisma.booking.create({
      data: {
        clientId,
        serviceId,
        scheduledAt: startAt.toDate(),
        endAt: endAt.toDate(),
        notes: notes || null,
        status: 'CONFIRMED'
      },
      include: {
        client: true,
        service: true
      }
    });

    const event = await googleCalendar.createEvent({
      calendarId: service.calendarId,
      booking,
      client,
      service
    });

    return prisma.booking.update({
      where: { id: booking.id },
      data: {
        calendarEventId: event.id
      },
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

    await googleCalendar.cancelEvent({
      calendarId: booking.service.calendarId,
      eventId: booking.calendarEventId
    });

    return prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED' },
      include: {
        client: true,
        service: true,
        paymentLink: true
      }
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
      amount: booking.service.price,
      currency: booking.service.currency,
      description: `${booking.service.name} - ${bookingId}`
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

  return {
    quoteAvailability,
    createBooking,
    cancelBooking,
    ensurePaymentLink
  };
}

module.exports = { createBookingService };

function looksLikeIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
