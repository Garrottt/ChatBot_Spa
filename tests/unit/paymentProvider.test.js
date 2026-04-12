const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentProvider, normalizeStatementDescriptor } = require('../../src/lib/paymentProvider');

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
