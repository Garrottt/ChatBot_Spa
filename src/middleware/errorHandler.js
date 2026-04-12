const { logger } = require('../lib/logger');

function errorHandler(error, _req, res, _next) {
  const statusCode = error.statusCode || 500;
  logger.error('Request failed', {
    message: error.message,
    statusCode,
    details: error.details || null
  });

  res.status(statusCode).json({
    error: error.message,
    details: error.details || null
  });
}

module.exports = { errorHandler };
