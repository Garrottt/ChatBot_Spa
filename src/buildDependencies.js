const { PrismaClient } = require('@prisma/client');

const { createOpenAIService } = require('./lib/openai');
const { createMetaClient } = require('./lib/meta');
const { createGoogleCalendarClient } = require('./lib/googleCalendar');
const { createPaymentProvider } = require('./lib/paymentProvider');
const { createClientService } = require('./services/clientService');
const { createConversationService } = require('./services/conversationService');
const { createMessageService } = require('./services/messageService');
const { createServiceCatalogService } = require('./services/serviceCatalogService');
const { createBookingService } = require('./services/bookingService');
const { createChatOrchestrator } = require('./services/chatOrchestrator');

async function buildDependencies(overrides = {}) {
  const prisma = overrides.prisma || new PrismaClient();
  const serviceCatalogService = overrides.serviceCatalogService || createServiceCatalogService({ prisma });
  const clientService = overrides.clientService || createClientService({ prisma });
  const conversationService = overrides.conversationService || createConversationService({ prisma });
  const messageService = overrides.messageService || createMessageService({ prisma });
  const googleCalendar = overrides.googleCalendar || createGoogleCalendarClient();
  const paymentProvider = overrides.paymentProvider || createPaymentProvider();
  const bookingService = overrides.bookingService || createBookingService({
    prisma,
    googleCalendar,
    paymentProvider,
    serviceCatalogService
  });
  const openAIService = overrides.openAIService || createOpenAIService();
  const metaClient = overrides.metaClient || createMetaClient();
  const chatOrchestrator = overrides.chatOrchestrator || createChatOrchestrator({
    openAIService,
    clientService,
    conversationService,
    messageService,
    bookingService,
    serviceCatalogService,
    paymentProvider,
    metaClient
  });

  return {
    prisma,
    clientService,
    conversationService,
    messageService,
    serviceCatalogService,
    bookingService,
    openAIService,
    metaClient,
    paymentProvider,
    googleCalendar,
    chatOrchestrator
  };
}

module.exports = { buildDependencies };
