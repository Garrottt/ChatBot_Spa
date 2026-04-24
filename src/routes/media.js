const express = require('express');

const { asyncHandler } = require('../lib/asyncHandler');

function createMediaRouter(dependencies) {
  const router = express.Router();
  const { mediaService } = dependencies;

  router.get('/messages/:messageId', asyncHandler(async (req, res) => {
    const media = await mediaService.getMessageMedia(req.params.messageId);

    res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(media.buffer);
  }));

  return router;
}

module.exports = { createMediaRouter };
