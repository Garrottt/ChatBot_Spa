const test = require('node:test');
const assert = require('node:assert/strict');

const { createBookingService } = require('../../src/services/bookingService');

function createPrismaStub(overrides = {}) {
  return {
    client: {
      findUnique: async () => ({ id: 'client-1', name: 'Gonza', lastName: 'Perez', formalId: '210931468' }),
      ...(overrides.client || {})
    },
    booking: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data, include }) => ({
        id: 'booking-1',
        ...data,
        client: { id: 'client-1', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
        service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP', calendarId: 'cal-1' },
        paymentLink: null
      }),
      findUnique: async () => ({
        id: 'booking-1',
        clientId: 'client-1',
        serviceId: 'svc-1',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentProofStatus: 'PENDING',
        scheduledAt: new Date('2026-04-15T10:00:00.000Z'),
        endAt: new Date('2026-04-15T11:00:00.000Z'),
        holdExpiresAt: new Date('2026-04-15T09:10:00.000Z'),
        depositAmount: 100,
        createdAt: new Date('2026-04-15T09:00:00.000Z'),
        client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
        service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP', calendarId: 'cal-1' },
        paymentLink: null
      }),
      update: async ({ data }) => ({
        id: 'booking-1',
        ...data,
        service: { name: 'Masaje relajante' },
        client: { whatsappNumber: '56911111111' },
        paymentLink: null
      }),
      ...(overrides.booking || {})
    },
    paymentLink: {
      create: async ({ data }) => ({ id: 'payment-1', ...data }),
      updateMany: async () => ({ count: 1 }),
      ...(overrides.paymentLink || {})
    }
  };
}

test('ensurePaymentLink uses fixed deposit amount instead of service price', async () => {
  let receivedAmount = null;
  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        findUnique: async () => ({
          id: 'booking-1',
          service: { name: 'Masaje relajante', price: 35000, currency: 'CLP' },
          paymentLink: null
        })
      }
    }),
    googleCalendar: {},
    paymentProvider: {
      createPaymentLink: async ({ amount }) => {
        receivedAmount = amount;
        return {
          provider: 'mercadopago',
          url: 'https://mercadopago.test/link',
          amount,
          currency: 'CLP',
          status: 'PENDING'
        };
      }
    },
    serviceCatalogService: {}
  });

  await bookingService.ensurePaymentLink('booking-1');

  assert.equal(receivedAmount, 100);
});

test('confirmPendingBooking creates the Google Calendar event only after payment approval', async () => {
  let eventCreated = false;
  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        findUnique: async () => ({
          id: 'booking-1',
          clientId: 'client-1',
          serviceId: 'svc-1',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          paymentProofStatus: 'PENDING',
          scheduledAt: new Date('2026-04-15T10:00:00.000Z'),
          endAt: new Date('2026-04-15T11:00:00.000Z'),
          holdExpiresAt: new Date(Date.now() + 600000),
          depositAmount: 100,
          createdAt: new Date(),
          client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
          service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP', calendarId: 'cal-1' },
          paymentLink: null
        }),
        update: async ({ data }) => ({
          id: 'booking-1',
          ...data,
          service: { name: 'Masaje relajante' },
          client: { whatsappNumber: '56911111111' },
          paymentLink: null
        }),
        updateMany: async () => ({ count: 0 })
      }
    }),
    googleCalendar: {
      createEvent: async () => {
        eventCreated = true;
        return { id: 'event-1' };
      }
    },
    paymentProvider: {},
    serviceCatalogService: {}
  });

  const booking = await bookingService.confirmPendingBooking('booking-1', {
    proofMetadata: { mediaId: 'media-1' },
    validation: { isValid: true }
  });

  assert.equal(eventCreated, true);
  assert.equal(booking.status, 'CONFIRMED');
  assert.equal(booking.paymentStatus, 'APPROVED');
});

test('expirePendingBookings marks overdue temporary bookings as expired', async () => {
  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        updateMany: async () => ({ count: 2 })
      },
      paymentLink: {
        updateMany: async () => ({ count: 2 })
      }
    }),
    googleCalendar: {},
    paymentProvider: {},
    serviceCatalogService: {}
  });

  const result = await bookingService.expirePendingBookings(new Date());

  assert.equal(result.expired, 2);
});

test('reconcileCalendarEvents recreates cancelled Google Calendar events for confirmed bookings', async () => {
  let receivedLookup = null;
  let createdEvents = 0;
  let updatedBookingId = null;
  let updatedCalendarEventId = null;

  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        findMany: async () => ([
          {
            id: 'booking-1',
            clientId: 'client-1',
            serviceId: 'svc-1',
            status: 'CONFIRMED',
            paymentStatus: 'APPROVED',
            paymentProofStatus: 'VALID',
            scheduledAt: new Date('2026-04-18T17:00:00.000Z'),
            endAt: new Date('2026-04-18T18:00:00.000Z'),
            calendarEventId: 'old-event-id',
            client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
            service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP', calendarId: 'cal-1' },
            paymentLink: null
          }
        ]),
        update: async ({ where, data }) => {
          updatedBookingId = where.id;
          updatedCalendarEventId = data.calendarEventId;
          return {
            id: where.id,
            calendarEventId: data.calendarEventId
          };
        }
      }
    }),
    googleCalendar: {
      getAvailableSlots: async () => [],
      getEvent: async ({ eventId }) => {
        receivedLookup = eventId;
        return { id: eventId, status: 'cancelled' };
      },
      createEvent: async () => {
        createdEvents += 1;
        return { id: 'new-event-id' };
      },
      cancelEvent: async () => ({ ok: true })
    },
    paymentProvider: {},
    serviceCatalogService: {}
  });

  const result = await bookingService.reconcileCalendarEvents();

  assert.equal(receivedLookup, 'old-event-id');
  assert.equal(createdEvents, 1);
  assert.equal(updatedBookingId, 'booking-1');
  assert.equal(updatedCalendarEventId, 'new-event-id');
  assert.equal(result.checked, 1);
  assert.equal(result.recreated, 1);
});
