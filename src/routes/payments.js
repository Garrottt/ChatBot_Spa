const express = require('express');
const { z } = require('zod');

const { asyncHandler } = require('../lib/asyncHandler');

const paymentSchema = z.object({
  bookingId: z.string().min(1)
});

function createPaymentRouter(dependencies) {
  const router = express.Router();
  const { bookingService } = dependencies;

  router.post('/link', asyncHandler(async (req, res) => {
    const payload = paymentSchema.parse(req.body);
    const result = await bookingService.ensurePaymentLink(payload.bookingId);
    res.status(201).json(result);
  }));

  return router;
}

module.exports = { createPaymentRouter };
