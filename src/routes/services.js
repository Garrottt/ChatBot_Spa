const express = require('express');

const { asyncHandler } = require('../lib/asyncHandler');

function createServiceRouter(dependencies) {
  const router = express.Router();
  const { serviceCatalogService } = dependencies;

  router.get('/', asyncHandler(async (_req, res) => {
    const services = await serviceCatalogService.listActiveServices();
    res.json({ items: services });
  }));

  return router;
}

module.exports = { createServiceRouter };
