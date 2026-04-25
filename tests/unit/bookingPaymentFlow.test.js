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
      update: async ({ where, data }) => ({ id: 'payment-1', bookingId: where.bookingId, ...data }),
      updateMany: async () => ({ count: 1 }),
      ...(overrides.paymentLink || {})
    },
    specialist: {
      findMany: async () => ([
        {
          id: 'specialist-1',
          name: 'Especialista',
          active: true,
          availabilities: [
            {
              id: 'availability-1',
              dayOfWeek: 3,
              startTime: '09:00:00',
              endTime: '18:00:00'
            }
          ]
        }
      ]),
      ...(overrides.specialist || {})
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

test('quoteAvailability builds slots from the specialist schedule for the selected service', async () => {
  const bookingService = createBookingService({
    prisma: createPrismaStub({
      specialist: {
        findMany: async () => ([
          {
            id: 'specialist-1',
            name: 'Ana',
            active: true,
            availabilities: [
              {
                id: 'availability-1',
                dayOfWeek: 3,
                startTime: '10:00:00',
                endTime: '12:00:00'
              }
            ]
          }
        ])
      }
    }),
    googleCalendar: {
      getAvailableSlots: async () => {
        throw new Error('specialist availability should be used instead of generic calendar slots');
      }
    },
    paymentProvider: {},
    serviceCatalogService: {
      getServiceById: async () => ({
        id: 'svc-1',
        name: 'Masaje relajante',
        durationMinutes: 60,
        price: 35000,
        currency: 'CLP',
        calendarId: 'cal-1'
      })
    }
  });

  const quote = await bookingService.quoteAvailability({
    serviceId: 'svc-1',
    date: '2026-04-29'
  });

  assert.equal(quote.slots.length, 2);
  assert.equal(quote.slots[0].specialistId, 'specialist-1');
  assert.equal(quote.slots[0].startsAt, '2026-04-29T10:00:00');
  assert.equal(quote.slots[1].startsAt, '2026-04-29T11:00:00');
});

test('createPendingBooking stores the available specialist for the booked slot', async () => {
  let createdBookingData = null;

  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        findFirst: async () => null,
        create: async ({ data }) => {
          createdBookingData = data;
          return {
            id: 'booking-1',
            ...data,
            service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP' },
            client: { id: 'client-1', whatsappNumber: '56911111111' },
            paymentLink: null
          };
        }
      },
      specialist: {
        findMany: async () => ([
          {
            id: 'specialist-1',
            name: 'Ana',
            active: true,
            availabilities: [
              {
                id: 'availability-1',
                dayOfWeek: 3,
                startTime: '09:00:00',
                endTime: '12:00:00'
              }
            ]
          }
        ])
      }
    }),
    googleCalendar: {},
    paymentProvider: {},
    serviceCatalogService: {
      getServiceById: async () => ({
        id: 'svc-1',
        name: 'Masaje relajante',
        durationMinutes: 60,
        price: 35000,
        currency: 'CLP',
        calendarId: 'cal-1'
      })
    }
  });

  const booking = await bookingService.createPendingBooking({
    clientId: 'client-1',
    serviceId: 'svc-1',
    scheduledAt: '2026-04-29T10:00:00',
    paymentMethod: 'BANK_TRANSFER',
    payer: {
      name: 'Gonza',
      lastName: 'Perez',
      formalId: '210931468'
    }
  });

  assert.equal(createdBookingData.specialistId, 'specialist-1');
  assert.equal(booking.specialistId, 'specialist-1');
});

test('ensurePaymentLink refreshes stale manual links when Mercado Pago is configured', async () => {
  let updatedProvider = null;
  let updatedUrl = null;

  const bookingService = createBookingService({
    prisma: createPrismaStub({
      booking: {
        findUnique: async () => ({
          id: 'booking-1',
          service: { name: 'Masaje relajante', price: 35000, currency: 'CLP' },
          paymentLink: {
            id: 'payment-1',
            provider: 'manual-link',
            url: 'https://pagos.tu-spa.cl/booking/booking-1',
            status: 'PENDING'
          }
        })
      },
      paymentLink: {
        update: async ({ data }) => {
          updatedProvider = data.provider;
          updatedUrl = data.url;
          return { id: 'payment-1', bookingId: 'booking-1', ...data };
        }
      }
    }),
    googleCalendar: {},
    paymentProvider: {
      createPaymentLink: async () => ({
        provider: 'mercadopago',
        url: 'https://mercadopago.test/checkout/pref-refresh',
        amount: 100,
        currency: 'CLP',
        status: 'PENDING'
      })
    },
    serviceCatalogService: {}
  });

  const paymentLink = await bookingService.ensurePaymentLink('booking-1');

  assert.equal(updatedProvider, 'mercadopago');
  assert.match(updatedUrl, /mercadopago\.test/);
  assert.equal(paymentLink.provider, 'mercadopago');
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

test('reconcileCalendarEvents recreates legacy dev events without querying Google Calendar', async () => {
  let getEventCalls = 0;
  let createdEvents = 0;

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
            calendarEventId: 'dev-event-booking-1',
            client: { id: 'client-1', whatsappNumber: '56911111111', name: 'Gonza', lastName: 'Perez', formalId: '210931468' },
            service: { id: 'svc-1', name: 'Masaje relajante', durationMinutes: 60, currency: 'CLP', calendarId: 'cal-1' },
            paymentLink: null
          }
        ]),
        update: async ({ where, data }) => ({
          id: where.id,
          calendarEventId: data.calendarEventId
        })
      }
    }),
    googleCalendar: {
      getAvailableSlots: async () => [],
      getEvent: async () => {
        getEventCalls += 1;
        return null;
      },
      createEvent: async () => {
        createdEvents += 1;
        return { id: 'real-event-id' };
      },
      cancelEvent: async () => ({ ok: true })
    },
    paymentProvider: {},
    serviceCatalogService: {}
  });

  const result = await bookingService.reconcileCalendarEvents();

  assert.equal(getEventCalls, 0);
  assert.equal(createdEvents, 1);
  assert.equal(result.checked, 1);
  assert.equal(result.recreated, 1);
});
