const { createApp } = require('./app');
const { buildDependencies } = require('./buildDependencies');
const { env } = require('./config/env');
const { logger } = require('./lib/logger');

async function main() {
  const dependencies = await buildDependencies();
  const app = createApp(dependencies);

  logger.info('Build marker', {
    buildMarker: 'interactive-sanitize-v2'
  });

  app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port}`);
  });

  // Alertas de ventana de pago: aviso de 5 min y notificacion de expiración.
  // Se ejecutan cada 60 segundos para respetar la ventana de 10 minutos.
  setInterval(async () => {
    try {
      await dependencies.reminderService.runHoldWarnings();
      await dependencies.reminderService.runHoldExpiryNotifications();
    } catch (error) {
      logger.error('Hold alert interval error', { error: error.message });
    }
  }, 60 * 1000);

  // Recordatorios de cita (24h antes). Intervalo configurable por env.
  setInterval(async () => {
    try {
      await dependencies.reminderService.runPendingReminders();
    } catch (error) {
      logger.error('Reminder interval error', { error: error.message });
    }
  }, env.bookingReminderIntervalMinutes * 60 * 1000);
}

main().catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});
