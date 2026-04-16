process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/chatbot_spa_test?schema=public';

const request = require('supertest');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../../src/app');

function createDependencies() {
  return {
    metaClient: {
      verifySignature: () => true,
      normalizeMessages: () => [],
      sendTextMessage: async () => ({ ok: true })
    },
    chatwootClient: {
      verifySignature: () => true
    },
    chatwootService: {
      handleWebhookEvent: async () => ({
        forwarded: true
      })
    },
    chatOrchestrator: {
      handleIncomingMessage: async () => ({ ok: true })
    },
    serviceCatalogService: {
      listActiveServices: async () => ([
        {
          id: 'svc-1',
          name: 'Masaje relajante',
          durationMinutes: 60,
          price: 35000,
          currency: 'CLP'
        }
      ])
    },
    reminderService: {
      runPendingReminders: async () => ({
        sent: 1
      })
    },
    bookingService: {
      ...{
        quoteAvailability: async () => ({
          service: {
            id: 'svc-1',
            name: 'Masaje relajante',
            durationMinutes: 60,
            price: 35000,
            currency: 'CLP'
          },
          slots: [
            {
              startsAt: '2026-04-15T10:00:00.000Z',
              endsAt: '2026-04-15T11:00:00.000Z'
            }
          ]
        }),
        createBooking: async () => ({
          id: 'booking-1'
        }),
        cancelBooking: async () => ({
          id: 'booking-1',
          status: 'CANCELLED'
        }),
        ensurePaymentLink: async () => ({
          id: 'payment-1',
          url: 'https://example.com/pay/booking-1'
        })
      },
      expirePendingBookings: async () => ({
        expired: 2
      })
    }
  };
}

test('booking quote route returns available slots', async () => {
  const app = createApp(createDependencies());
  const response = await request(app)
    .post('/api/bookings/quote')
    .send({
      serviceId: 'svc-1',
      date: '2026-04-15'
    });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.service.name, 'Masaje relajante');
  assert.equal(response.body.slots.length, 1);
});

test('payment link route returns generated link', async () => {
  const app = createApp(createDependencies());
  const response = await request(app)
    .post('/api/payments/link')
    .send({
      bookingId: 'booking-1'
    });

  assert.equal(response.statusCode, 201);
  assert.match(response.body.url, /\/pay\//);
});

test('booking reminders route runs pending reminders', async () => {
  const app = createApp(createDependencies());
  const response = await request(app)
    .post('/api/bookings/reminders/run')
    .send({});

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sent, 1);
});

test('expire pending route returns expired count', async () => {
  const app = createApp(createDependencies());
  const response = await request(app)
    .post('/api/bookings/expire-pending')
    .send({});

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.expired, 2);
});

test('chatwoot webhook route accepts agent events', async () => {
  const app = createApp(createDependencies());
  const response = await request(app)
    .post('/chatwoot/webhooks')
    .send({
      event: 'message_created',
      message: {
        id: 777,
        message_type: 'outgoing',
        private: false,
        content: 'Hola'
      }
    });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.forwarded, true);
});
