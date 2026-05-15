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
  specialistId: z.string().trim().min(1).optional(),
  templateName: z.string().trim().min(1).optional(),
  templateLanguage: z.string().trim().min(1).optional()
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
    const result = await metaClient.sendTextMessage(targetNumber, payload.content);
    if (result?.skipped) {
      throw new AppError('WhatsApp outbound messaging is not configured in this environment.', 503);
    }
    const providerMessageId = result?.messages?.[0]?.id || null;
    await messageService.createOutgoingMessage({
      conversationId: conversation.id,
      clientId: conversation.clientId,
      content: payload.content,
      providerId: providerMessageId,
      messageType: 'text',
      metadata: {
        intent: 'agent_reply',
        step: 'crm_manual_send',
        source: 'crm',
        providerStatus: 'accepted'
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
    await conversationService.updateConversation(conversation.id, {
      currentIntent: 'campaign',
      currentStep: 'answered'
    });

    const targetNumber = conversation.client?.whatsappNumber || payload.whatsappNumber;

    try {
      // Determine which template name to use: payload > env default
      const { env } = require('../config/env');
      const resolvedTemplateName = payload.templateName || env.metaCampaignTemplateName || null;
      const resolvedLanguage = payload.templateLanguage || env.metaCampaignTemplateLanguage || 'es';

      let result;
      if (resolvedTemplateName) {
        // Preferred path: send as an approved WhatsApp Template to bypass the
        // 24-hour session window. Variables are injected as body parameters.
        const headerImageUrl = env.metaCampaignTemplateHeaderImageUrl || null;
        const bodyParams = buildTemplateBodyParams(payload.message, headerImageUrl);
        result = await metaClient.sendTemplateMessage(
          targetNumber,
          resolvedTemplateName,
          resolvedLanguage,
          bodyParams
        );
      } else {
        // Fallback: send as plain text (only works within a 24h session window).
        result = await metaClient.sendTextMessage(targetNumber, payload.message);
      }

      if (result?.skipped) {
        throw new AppError('WhatsApp outbound messaging is not configured in this environment.', 503);
      }
      const providerMessageId = result?.messages?.[0]?.id || null;
      await messageService.createOutgoingMessage({
        conversationId: conversation.id,
        clientId: conversation.clientId,
        content: payload.message,
        providerId: providerMessageId,
        messageType: resolvedTemplateName ? 'template' : 'text',
        metadata: {
          intent: 'campaign',
          step: 'campaign_sent',
          source: 'campaign',
          campaignId: payload.campaignId,
          offerId: payload.offerId,
          campaignRecipientId: payload.campaignRecipientId,
          templateName: resolvedTemplateName || null,
          providerStatus: 'accepted'
        }
      });

      await campaignService.markRecipientSent(payload.campaignRecipientId, conversation.id, providerMessageId);
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

/**
 * Builds the WhatsApp template component array for the API call.
 *
 * - If `imageUrl` is provided, prepends a `header` component with the image
 *   (required when the approved template was created with an IMAGE header).
 * - The rendered `message` is sent as the single `{{1}}` body parameter.
 *
 * Adjust this function if your template uses multiple body variables or
 * additional component types (e.g. buttons with dynamic URLs).
 */
function buildTemplateBodyParams(renderedMessage, imageUrl = null) {
  const components = [];

  if (imageUrl) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: { link: imageUrl }
        }
      ]
    });
  }

  if (renderedMessage && renderedMessage.trim()) {
    components.push({
      type: 'body',
      parameters: [
        {
          type: 'text',
          text: renderedMessage
        }
      ]
    });
  }

  return components;
}

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
