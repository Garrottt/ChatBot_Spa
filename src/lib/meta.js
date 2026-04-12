const crypto = require('crypto');
const axios = require('axios');

const { env } = require('../config/env');
const { AppError } = require('./errors');
const { logger } = require('./logger');

function createMetaClient(overrides = {}) {
  const httpClient = overrides.httpClient || axios.create({
    baseURL: `https://graph.facebook.com/${env.metaApiVersion}`,
    timeout: 10000
  });

  function verifySignature(signatureHeader, rawBody) {
    if (!env.metaAppSecret || !signatureHeader || !rawBody) {
      return env.nodeEnv !== 'production';
    }

    const expected = crypto
      .createHmac('sha256', env.metaAppSecret)
      .update(rawBody)
      .digest('hex');

    return signatureHeader === `sha256=${expected}`;
  }

  function normalizeMessages(body) {
    const entries = body.entry || [];
    const normalized = [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) {
          normalized.push(normalizeMessage(message, value));
        }
      }
    }

    return normalized.filter(Boolean);
  }

  async function sendTextMessage(to, text) {
    return sendPayload(to, {
      type: 'text',
      text: { body: text }
    });
  }

  async function sendButtonsMessage(to, bodyText, buttons) {
    return sendPayload(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((button) => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: button.title
            }
          }))
        }
      }
    });
  }

  async function sendListMessage(to, bodyText, buttonText, sections) {
    return sendPayload(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText,
          sections: sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              id: row.id,
              title: row.title,
              description: row.description
            }))
          }))
        }
      }
    });
  }

  async function sendPayload(to, payload) {
    if (!env.metaAccessToken || !env.metaPhoneNumberId) {
      logger.warn('Meta credentials missing, skipping outbound message', { to, payload });
      return { skipped: true };
    }

    try {
      const response = await httpClient.post(
        `/${env.metaPhoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          ...payload
        },
        {
          headers: {
            Authorization: `Bearer ${env.metaAccessToken}`
          }
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Meta sendPayload failed', {
        to,
        payloadType: payload.type,
        status: error.response?.status || null,
        data: error.response?.data || null,
        message: error.message
      });

      throw new AppError('No pude enviar la respuesta por WhatsApp en este momento.', 502);
    }
  }

  return {
    verifySignature,
    normalizeMessages,
    sendTextMessage,
    sendButtonsMessage,
    sendListMessage
  };
}

function normalizeMessage(message, value) {
  const profileName = value.contacts?.[0]?.profile?.name || null;
  const common = {
    providerMessageId: message.id,
    from: message.from,
    type: message.type,
    timestamp: message.timestamp,
    profileName
  };

  if (message.type === 'text') {
    return {
      ...common,
      text: message.text?.body || '',
      selectedId: null
    };
  }

  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    const listReply = message.interactive?.list_reply;
    const selected = buttonReply || listReply;

    return {
      ...common,
      text: selected?.title || '',
      selectedId: selected?.id || null
    };
  }

  return {
    ...common,
    text: '',
    selectedId: null
  };
}

module.exports = { createMetaClient };
