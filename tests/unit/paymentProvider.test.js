const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentProvider, normalizeStatementDescriptor } = require('../../src/lib/paymentProvider');
const { AppError } = require('../../src/lib/errors');

test('normalizeStatementDescriptor formats spa name for Mercado Pago', () => {
  assert.equal(normalizeStatementDescriptor('Spa Ikigai Ovalle'), 'SPA IKIGAI OV');
});

test('payment provider creates Mercado Pago link using booking amount', async () => {
  const calls = [];
  const paymentProvider = createPaymentProvider({
    preferenceClient: {
      create: async ({ body }) => {
        calls.push(body);
        return {
          id: 'pref-1',
          init_point: 'https://mercadopago.test/checkout/pref-1'
        };
      }
    }
  });

  const paymentLink = await paymentProvider.createPaymentLink({
    bookingId: 'booking-1',
    amount: 15000,
    currency: 'CLP',
    description: 'Masaje relajante'
  });

  assert.equal(calls[0].items[0].unit_price, 15000);
  assert.equal(calls[0].items[0].title, 'Masaje relajante');
  assert.equal(paymentLink.provider, 'mercadopago');
  assert.match(paymentLink.url, /mercadopago\.test/);
});

test('payment provider accepts checkout URL from response.body.init_point', async () => {
  const paymentProvider = createPaymentProvider({
    preferenceClient: {
      create: async () => ({
        body: {
          id: 'pref-2',
          init_point: 'https://mercadopago.test/checkout/pref-2'
        }
      })
    }
  });

  const paymentLink = await paymentProvider.createPaymentLink({
    bookingId: 'booking-2',
    amount: 15000,
    currency: 'CLP',
    description: 'Masaje relajante'
  });

  assert.equal(paymentLink.provider, 'mercadopago');
  assert.match(paymentLink.url, /mercadopago\.test\/checkout\/pref-2/);
});

test('payment provider throws when Mercado Pago does not return a checkout URL', async () => {
  const paymentProvider = createPaymentProvider({
    preferenceClient: {
      create: async () => ({
        id: 'pref-3'
      })
    }
  });

  await assert.rejects(
    () => paymentProvider.createPaymentLink({
      bookingId: 'booking-3',
      amount: 15000,
      currency: 'CLP',
      description: 'Masaje relajante'
    }),
    (error) => error instanceof AppError && /link de pago valido/i.test(error.message)
  );
});
