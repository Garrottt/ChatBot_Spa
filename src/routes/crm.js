const express = require('express');
const { z } = require('zod');

const { asyncHandler } = require('../lib/asyncHandler');
const { AppError } = require('../lib/errors');

const sendManualMessageSchema = z.object({
  whatsappNumber: z.string().trim().min(1),
  content: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
  clientId: z.string().trim().min(1)
});

function createCrmRouter(dependencies) {
  const router = express.Router();
  const { metaClient, messageService, conversationService, clientService } = dependencies;

  router.post('/send-message', asyncHandler(async (req, res) => {
    const payload = sendManualMessageSchema.parse(req.body);
    const conversation = await resolveConversation({
      payload,
      conversationService,
      clientService
    });

    if (!conversation || conversation.clientId !== payload.clientId) {
      throw new AppError('Conversation not found for the provided client.', 404);
    }

    const targetNumber = conversation.client?.whatsappNumber || payload.whatsappNumber;
    await metaClient.sendTextMessage(targetNumber, payload.content);
    await messageService.createOutgoingMessage({
      conversationId: conversation.id,
      clientId: conversation.clientId,
      content: payload.content,
      messageType: 'text',
      metadata: {
        intent: 'agent_reply',
        step: 'crm_manual_send',
        source: 'crm'
      }
    });

    res.status(200).json({
      sent: true
    });
  }));

  return router;
}

module.exports = { createCrmRouter };

async function resolveConversation({ payload, conversationService, clientService }) {
  if (payload.conversationId) {
    return conversationService.findById(payload.conversationId, {
      include: {
        client: true
      }
    });
  }

  const client = await clientService.getClientById(payload.clientId);
  if (!client) {
    return null;
  }

  const conversation = await conversationService.getOrCreateActiveConversation(payload.clientId);
  return conversationService.findById(conversation.id, {
    include: {
      client: true
    }
  });
}
