const express = require('express');
const { z } = require('zod');

const { asyncHandler } = require('../lib/asyncHandler');

const quoteSchema = z.object({
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
});

const createBookingSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().min(1),
  scheduledAt: z.string().datetime(),
  notes: z.string().optional()
});

function createBookingRouter(dependencies) {
  const router = express.Router();
  const { bookingService } = dependencies;

  router.post('/quote', asyncHandler(async (req, res) => {
    const payload = quoteSchema.parse(req.body);
    const result = await bookingService.quoteAvailability(payload);
    res.json(result);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const payload = createBookingSchema.parse(req.body);
    const booking = await bookingService.createBooking(payload);
    res.status(201).json(booking);
  }));

  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    const result = await bookingService.cancelBooking(req.params.id);
    res.json(result);
  }));

  return router;
}

module.exports = { createBookingRouter };
