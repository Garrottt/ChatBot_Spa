const { createApp } = require('./app');
const { buildDependencies } = require('./buildDependencies');
const { env } = require('./config/env');
const { logger } = require('./lib/logger');

async function main() {
  const dependencies = await buildDependencies();
  const app = createApp(dependencies);

  app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port}`);
  });
}

main().catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});
