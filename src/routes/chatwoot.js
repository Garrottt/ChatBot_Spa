const express = require('express');

const { asyncHandler } = require('../lib/asyncHandler');
const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');

function createChatwootRouter(dependencies) {
  const router = express.Router();
  const { chatwootClient, chatwootService } = dependencies;

  router.post('/', asyncHandler(async (req, res) => {
    const signature = req.headers['x-chatwoot-signature'];
    const timestamp = req.headers['x-chatwoot-timestamp'];
    const verified = chatwootClient.verifySignature(signature, req.rawBody, timestamp);

    if (!verified) {
      throw new AppError('Invalid Chatwoot signature', 401);
    }

    const result = await chatwootService.handleWebhookEvent(req.body);
    logger.info('Processed Chatwoot webhook', {
      event: req.body?.event || null,
      result
    });
    res.status(200).json({
      received: true,
      ...result
    });
  }));

  return router;
}

module.exports = { createChatwootRouter };
