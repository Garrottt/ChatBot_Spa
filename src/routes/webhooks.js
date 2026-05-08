const express = require('express');

const { asyncHandler } = require('../lib/asyncHandler');
const { AppError } = require('../lib/errors');
const { env } = require('../config/env');

function createWebhookRouter(dependencies) {
  const router = express.Router();
  const { metaClient, chatOrchestrator, campaignService, messageService } = dependencies;

  router.get('/', asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === env.metaVerifyToken) {
      return res.status(200).send(challenge);
    }

    throw new AppError('Invalid webhook verification token', 403);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const verified = metaClient.verifySignature(signature, req.rawBody);

    if (!verified) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'Rejected Meta webhook with invalid signature',
        path: req.originalUrl,
        userAgent: req.headers['user-agent'] || null,
        forwardedFor: req.headers['x-forwarded-for'] || null,
        remoteAddress: req.ip || null
      }));
      throw new AppError('Invalid Meta signature', 401);
    }

    const messages = metaClient.normalizeMessages(req.body);
    const statuses = metaClient.normalizeStatusUpdates(req.body);

    for (const message of messages) {
      await chatOrchestrator.handleIncomingMessage(message);
    }

    for (const status of statuses) {
      await campaignService.markRecipientDeliveryByProviderMessageId(
        status.providerMessageId,
        status.status,
        status
      ).catch(() => null);

      if (messageService?.findOutgoingByProviderId && messageService?.updateMessage) {
        const outgoingMessage = await messageService.findOutgoingByProviderId(status.providerMessageId);
        if (outgoingMessage) {
          await messageService.updateMessage(outgoingMessage.id, {
            metadata: {
              ...(outgoingMessage.metadata || {}),
              providerStatus: status.status,
              providerStatusAt: status.timestamp || null,
              providerStatusErrors: status.errors || []
            }
          });
        }
      }
    }

    res.status(200).json({
      received: true,
      processed: messages.length + statuses.length
    });
  }));

  return router;
}

module.exports = { createWebhookRouter };
