const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { env } = require('./config/env');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const { notFoundHandler } = require('./middleware/notFound');
const { createWebhookRouter } = require('./routes/webhooks');
const { createChatwootRouter } = require('./routes/chatwoot');
const { createBookingRouter } = require('./routes/bookings');
const { createPaymentRouter } = require('./routes/payments');
const { createServiceRouter } = require('./routes/services');

function createApp(dependencies) {
  const app = express();
  app.get("/ping", (req, res) => {
    res.status(200).send("pong");
  });
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  app.use(createRateLimiter());
  app.use(express.json({
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    }
  }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, env: env.nodeEnv });
  });

  app.use('/webhooks/meta', createWebhookRouter(dependencies));
  app.use('/chatwoot/webhook', createChatwootRouter(dependencies));
  app.use('/chatwoot/webhooks', createChatwootRouter(dependencies));
  app.use('/api/bookings', createBookingRouter(dependencies));
  app.use('/api/payments', createPaymentRouter(dependencies));
  app.use('/api/services', createServiceRouter(dependencies));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
