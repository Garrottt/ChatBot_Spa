const express = require('express');

const { asyncHandler } = require('../lib/asyncHandler');
const { AppError } = require('../lib/errors');
const { env } = require('../config/env');

function createWebhookRouter(dependencies) {
  const router = express.Router();
  const { metaClient, chatOrchestrator } = dependencies;

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
      throw new AppError('Invalid Meta signature', 401);
    }

    const messages = metaClient.normalizeMessages(req.body);

    for (const message of messages) {
      await chatOrchestrator.handleIncomingMessage(message);
    }

    res.status(200).json({
      received: true,
      processed: messages.length
    });
  }));

  return router;
}

module.exports = { createWebhookRouter };
