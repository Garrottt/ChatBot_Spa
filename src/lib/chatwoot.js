const crypto = require('crypto');
const axios = require('axios');

const { env } = require('../config/env');
const { AppError } = require('./errors');
const { logger } = require('./logger');

function createChatwootClient(overrides = {}) {
  const httpClient = overrides.httpClient || axios.create({
    baseURL: env.chatwootBaseUrl,
    timeout: 10000
  });

  function isConfigured() {
    if (usesPublicInboxApi()) {
      return Boolean(env.chatwootBaseUrl && env.chatwootInboxId);
    }

    return Boolean(
      env.chatwootBaseUrl &&
      env.chatwootAccountId &&
      env.chatwootInboxId &&
      env.chatwootApiAccessToken
    );
  }

  function verifySignature(signatureHeader, rawBody, timestampHeader) {
    if (!env.chatwootWebhookSecret) {
      return true;
    }

    if (!signatureHeader || !rawBody || !timestampHeader) {
      return env.nodeEnv !== 'production';
    }

    const expected = crypto
      .createHmac('sha256', env.chatwootWebhookSecret)
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

    return safeEqual(signatureHeader, expected) || safeEqual(signatureHeader, `sha256=${expected}`);
  }

  async function createContact({ name, phoneNumber, identifier, email }) {
    ensureConfigured();

    try {
      const response = usesPublicInboxApi()
        ? await httpClient.post(
          `/public/api/v1/inboxes/${env.chatwootInboxId}/contacts`,
          {
            name,
            phone_number: phoneNumber || undefined,
            identifier: identifier || undefined,
            identifier_hash: buildIdentifierHash(identifier),
            email: email || undefined,
            custom_attributes: {}
          },
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
        : await httpClient.post(
          `/api/v1/accounts/${env.chatwootAccountId}/contacts`,
          {
            inbox_id: Number(env.chatwootInboxId),
            name,
            phone_number: phoneNumber || undefined,
            identifier: identifier || undefined,
            email: email || undefined
          },
          {
            headers: buildHeaders()
          }
        );

      return response.data;
    } catch (error) {
      throw wrapChatwootError('No pude crear el contacto en Chatwoot.', error);
    }
  }

  async function createConversation({ sourceId, contactId, customAttributes }) {
    ensureConfigured();

    try {
      const response = usesPublicInboxApi()
        ? await httpClient.post(
          `/public/api/v1/inboxes/${env.chatwootInboxId}/contacts/${sourceId}/conversations`,
          {
            custom_attributes: customAttributes || {}
          },
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
        : await httpClient.post(
          `/api/v1/accounts/${env.chatwootAccountId}/conversations`,
          {
            inbox_id: Number(env.chatwootInboxId),
            source_id: sourceId,
            contact_id: contactId,
            custom_attributes: customAttributes || {}
          },
          {
            headers: buildHeaders()
          }
        );

      return response.data;
    } catch (error) {
      throw wrapChatwootError('No pude crear la conversacion en Chatwoot.', error);
    }
  }

  async function createMessage({ conversationId, content, messageType = 'incoming', contactIdentifier }) {
    ensureConfigured();

    try {
      const response = usesPublicInboxApi()
        ? await httpClient.post(
          `/public/api/v1/inboxes/${env.chatwootInboxId}/contacts/${contactIdentifier}/conversations/${conversationId}/messages`,
          {
            content,
            echo_id: `${Date.now()}`
          },
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
        : await httpClient.post(
          `/api/v1/accounts/${env.chatwootAccountId}/conversations/${conversationId}/messages`,
          {
            content,
            message_type: messageType,
            private: false,
            content_type: 'text',
            content_attributes: {}
          },
          {
            headers: buildHeaders()
          }
        );

      return response.data;
    } catch (error) {
      throw wrapChatwootError('No pude registrar el mensaje en Chatwoot.', error);
    }
  }

  return {
    isConfigured,
    verifySignature,
    createContact,
    createConversation,
    createMessage
  };
}

module.exports = { createChatwootClient };

function usesPublicInboxApi() {
  return !/^\d+$/.test(String(env.chatwootInboxId || '').trim());
}

function buildHeaders() {
  return {
    api_access_token: env.chatwootApiAccessToken,
    'Content-Type': 'application/json'
  };
}

function ensureConfigured() {
  if (usesPublicInboxApi()) {
    if (!env.chatwootBaseUrl || !env.chatwootInboxId) {
      throw new AppError('La integracion con Chatwoot no esta configurada completamente.', 500);
    }
    return;
  }

  if (!env.chatwootBaseUrl || !env.chatwootAccountId || !env.chatwootInboxId || !env.chatwootApiAccessToken) {
    throw new AppError('La integracion con Chatwoot no esta configurada completamente.', 500);
  }
}

function wrapChatwootError(message, error) {
  logger.error('Chatwoot request failed', {
    status: error.response?.status || null,
    data: error.response?.data || null,
    message: error.message
  });

  return new AppError(message, 502);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildIdentifierHash(identifier) {
  if (!identifier || !env.chatwootAccountId || /^\d+$/.test(String(env.chatwootAccountId || '').trim())) {
    return undefined;
  }

  return crypto
    .createHmac('sha256', env.chatwootAccountId)
    .update(String(identifier))
    .digest('hex');
}
