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

const sendCampaignMessageSchema = z.object({
  whatsappNumber: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
  campaignId: z.string().trim().min(1),
  offerId: z.string().trim().min(1),
  campaignRecipientId: z.string().trim().min(1),
  message: z.string().trim().min(1),
  serviceId: z.string().trim().min(1).optional(),
  specialistId: z.string().trim().min(1).optional()
});

function createCrmRouter(dependencies) {
  const router = express.Router();
  const { metaClient, messageService, conversationService, clientService, campaignService } = dependencies;

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

  router.post('/send-campaign', asyncHandler(async (req, res) => {
    const payload = sendCampaignMessageSchema.parse(req.body);
    const conversation = await resolveConversation({
      payload,
      conversationService,
      clientService
    });

    if (!conversation || conversation.clientId !== payload.clientId) {
      throw new AppError('Conversation not found for the provided client.', 404);
    }

    const offer = await campaignService.getOfferById(payload.offerId);
    if (!offer) {
      throw new AppError('Offer not found for campaign send.', 404);
    }

    await conversationService.mergeCollectedData(conversation.id, {
      campaignContext: {
        source: 'campaign',
        campaignId: payload.campaignId,
        offerId: payload.offerId,
        campaignRecipientId: payload.campaignRecipientId,
        serviceId: payload.serviceId || offer.serviceId || null,
        specialistId: payload.specialistId || offer.specialistId || null,
        activatedAt: new Date().toISOString()
      }
    });

    const targetNumber = conversation.client?.whatsappNumber || payload.whatsappNumber;

    try {
      await metaClient.sendTextMessage(targetNumber, payload.message);
      await messageService.createOutgoingMessage({
        conversationId: conversation.id,
        clientId: conversation.clientId,
        content: payload.message,
        messageType: 'text',
        metadata: {
          intent: 'campaign',
          step: 'campaign_sent',
          source: 'campaign',
          campaignId: payload.campaignId,
          offerId: payload.offerId,
          campaignRecipientId: payload.campaignRecipientId
        }
      });

      await campaignService.markRecipientSent(payload.campaignRecipientId, conversation.id);
    } catch (error) {
      await campaignService.markRecipientFailed(payload.campaignRecipientId, error.message);
      throw error;
    }

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
