const { MercadoPagoConfig, Preference } = require('mercadopago');

const { env } = require('../config/env');
const { logger } = require('./logger');

function createPaymentProvider(overrides = {}) {
  const hasMercadoPago = Boolean(env.mercadoPagoAccessToken);
  const preferenceClient = overrides.preferenceClient || (
    hasMercadoPago
      ? new Preference(new MercadoPagoConfig({ accessToken: env.mercadoPagoAccessToken }))
      : null
  );

  async function createPaymentLink({ bookingId, amount, currency = 'CLP', description = 'Reserva Spa Ikigai Ovalle' }) {
    if (!preferenceClient) {
      return {
        provider: env.paymentProviderName,
        url: `${env.paymentBaseUrl.replace(/\/$/, '')}/booking/${bookingId}`,
        amount,
        currency,
        status: 'PENDING'
      };
    }

    const body = {
      items: [
        {
          id: bookingId,
          title: description,
          quantity: 1,
          currency_id: currency,
          unit_price: Number(amount)
        }
      ],
      external_reference: bookingId,
      statement_descriptor: normalizeStatementDescriptor(env.spaName),
      back_urls: {
        success: `${env.mercadoPagoPublicBaseUrl.replace(/\/$/, '')}/payments/success`,
        failure: `${env.mercadoPagoPublicBaseUrl.replace(/\/$/, '')}/payments/failure`,
        pending: `${env.mercadoPagoPublicBaseUrl.replace(/\/$/, '')}/payments/pending`
      },
      auto_return: 'approved'
    };

    if (env.mercadoPagoWebhookUrl) {
      body.notification_url = env.mercadoPagoWebhookUrl;
    }

    const response = await preferenceClient.create({ body });
    logger.info('Mercado Pago preference created', {
      bookingId,
      preferenceId: response.id || response.body?.id || null
    });

    return {
      provider: 'mercadopago',
      url: response.init_point || response.sandbox_init_point || response.body?.init_point,
      amount,
      currency,
      status: 'PENDING'
    };
  }

  return {
    createPaymentLink
  };
}

function normalizeStatementDescriptor(value) {
  return String(value || 'SPA IKIGAI')
    .normalize('NFD')
    .replace(/[^\w\s]/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 13)
    .toUpperCase();
}

module.exports = { createPaymentProvider, normalizeStatementDescriptor };
