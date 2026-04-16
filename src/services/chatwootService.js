const { env } = require('../config/env');
const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');

function createChatwootService({
  chatwootClient,
  conversationService,
  messageService,
  metaClient
}) {
  async function captureIncomingMessage({ client, conversation, message }) {
    if (!chatwootClient?.isConfigured?.()) {
      return { skipped: true, reason: 'not_configured' };
    }

    const content = buildIncomingContent(message);
    if (!content) {
      return { skipped: true, reason: 'empty_message' };
    }

    const linkage = await ensureConversationLink({ client, conversation });
    await chatwootClient.createMessage({
      conversationId: linkage.conversationId,
      contactIdentifier: linkage.sourceId,
      content,
      messageType: 'incoming'
    });

    return { synced: true };
  }

  async function handleWebhookEvent(payload) {
    if (!chatwootClient?.isConfigured?.()) {
      logger.warn('Chatwoot webhook ignored because integration is not configured');
      return { skipped: true, reason: 'not_configured' };
    }

    if (payload.event !== 'message_created') {
      logger.info('Chatwoot webhook ignored', {
        reason: 'unsupported_event',
        event: payload.event || null
      });
      return { ignored: true, reason: 'unsupported_event' };
    }

    const message = payload.message || {};
    const isAgentMessage = isPublicAgentMessage(payload);
    if (!isAgentMessage) {
      logger.info('Chatwoot webhook ignored', {
        reason: 'not_public_outgoing',
        messageType: message.message_type || null,
        private: Boolean(message.private),
        senderType: message.sender?.type || payload.sender?.type || null
      });
      return { ignored: true, reason: 'not_public_outgoing' };
    }

    const content = String(message.content || '').trim();
    if (!content) {
      logger.info('Chatwoot webhook ignored', {
        reason: 'empty_content',
        chatwootMessageId: message.id || null
      });
      return { ignored: true, reason: 'empty_content' };
    }

    const providerId = `chatwoot:${message.id}`;
    const existing = await messageService.findOutgoingByProviderId(providerId);
    if (existing) {
      logger.info('Chatwoot webhook ignored', {
        reason: 'duplicate',
        providerId
      });
      return { ignored: true, reason: 'duplicate' };
    }

    const chatwootConversationId = payload.conversation?.id || message.conversation_id;
    if (!chatwootConversationId) {
      logger.warn('Chatwoot webhook missing conversation id', { payload });
      return { ignored: true, reason: 'missing_conversation_id' };
    }

    const conversation = await conversationService.findByChatwootConversationId(chatwootConversationId);
    if (!conversation) {
      logger.warn('Chatwoot webhook conversation not mapped locally', { chatwootConversationId });
      return { ignored: true, reason: 'conversation_not_found' };
    }

    await metaClient.sendTextMessage(conversation.client.whatsappNumber, content);
    logger.info('Forwarded Chatwoot reply to WhatsApp', {
      chatwootConversationId,
      whatsappNumber: conversation.client.whatsappNumber,
      providerId
    });
    await messageService.createOutgoingMessage({
      conversationId: conversation.id,
      clientId: conversation.clientId,
      content,
      providerId,
      messageType: 'text',
      metadata: {
        intent: 'agent_reply',
        step: 'chatwoot_forwarded',
        chatwootMessageId: message.id,
        chatwootConversationId
      }
    });

    return { forwarded: true };
  }

  async function ensureConversationLink({ client, conversation }) {
    const existingChatwoot = conversation?.collectedData?.chatwoot || {};
    if (existingChatwoot.conversationId && existingChatwoot.contactId && existingChatwoot.sourceId) {
      return existingChatwoot;
    }

    const contact = await chatwootClient.createContact({
      name: [client.name, client.lastName].filter(Boolean).join(' ').trim() || client.whatsappNumber,
      phoneNumber: formatWhatsappNumber(client.whatsappNumber),
      identifier: client.whatsappNumber,
      email: null
    });

    const sourceId = pickSourceId(contact);
    if (!sourceId) {
      throw new AppError('No pude vincular el contacto con el inbox de Chatwoot.', 502);
    }

    const remoteConversation = await chatwootClient.createConversation({
      sourceId,
      contactId: contact.id,
      customAttributes: {
        local_conversation_id: conversation.id,
        whatsapp_number: client.whatsappNumber
      }
    });

    const linkage = {
      contactId: contact.id,
      sourceId,
      conversationId: remoteConversation.id
    };

    await conversationService.mergeCollectedData(conversation.id, {
      chatwoot: linkage
    });

    conversation.collectedData = {
      ...(conversation.collectedData || {}),
      chatwoot: linkage
    };

    return linkage;
  }

  return {
    captureIncomingMessage,
    handleWebhookEvent
  };
}

module.exports = { createChatwootService };

function buildIncomingContent(message) {
  if (message.type === 'image') {
    const caption = String(message.media?.caption || message.text || '').trim();
    return caption
      ? `[Imagen recibida por WhatsApp]\n${caption}`
      : '[Imagen recibida por WhatsApp]';
  }

  return String(message.text || message.selectedId || '').trim();
}

function formatWhatsappNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) {
    return null;
  }

  return `+${digits}`;
}

function pickSourceId(contact) {
  const inboxId = Number.parseInt(env.chatwootInboxId || '', 10);
  const inbox = (contact.contact_inboxes || []).find((item) => Number(item.inbox?.id || item.inbox_id) === inboxId);
  return inbox?.source_id || contact.source_id;
}

function isPublicAgentMessage(payload) {
  const message = payload.message || {};
  if (message.private) {
    return false;
  }

  if (message.message_type === 'outgoing') {
    return true;
  }

  const senderType = String(message.sender?.type || payload.sender?.type || '').toLowerCase();
  if (senderType === 'user') {
    return true;
  }

  return false;
}
