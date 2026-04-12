const rateLimit = require('express-rate-limit');

function createRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  });
}

module.exports = { createRateLimiter };
