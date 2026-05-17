const { PrismaClient } = require('@prisma/client');

const { createOpenAIService } = require('./lib/openai');
const { createMetaClient } = require('./lib/meta');
const { createChatwootClient } = require('./lib/chatwoot');
const { createGoogleCalendarClient } = require('./lib/googleCalendar');
const { createPaymentProvider } = require('./lib/paymentProvider');
const { createClientService } = require('./services/clientService');
const { createConversationService } = require('./services/conversationService');
const { createMessageService } = require('./services/messageService');
const { createServiceCatalogService } = require('./services/serviceCatalogService');
const { createBookingService } = require('./services/bookingService');
const { createCampaignService } = require('./services/campaignService');
const { createAlertService } = require('./services/alertService');
const { createChatOrchestrator } = require('./services/chatOrchestrator');
const { createChatwootService } = require('./services/chatwootService');
const { createReminderService } = require('./services/reminderService');
const { createMediaService } = require('./services/mediaService');

async function buildDependencies(overrides = {}) {
  const prisma = overrides.prisma || new PrismaClient();
  const serviceCatalogService = overrides.serviceCatalogService || createServiceCatalogService({ prisma });
  const clientService = overrides.clientService || createClientService({ prisma });
  const conversationService = overrides.conversationService || createConversationService({ prisma });
  const messageService = overrides.messageService || createMessageService({ prisma });
  const campaignService = overrides.campaignService || createCampaignService({ prisma });
  const alertService = overrides.alertService || createAlertService({ prisma });
  const googleCalendar = overrides.googleCalendar || createGoogleCalendarClient();
  const paymentProvider = overrides.paymentProvider || createPaymentProvider();
  const bookingService = overrides.bookingService || createBookingService({
    prisma,
    googleCalendar,
    paymentProvider,
    serviceCatalogService,
    campaignService,
    alertService
  });
  const openAIService = overrides.openAIService || createOpenAIService();
  const metaClient = overrides.metaClient || createMetaClient();
  const chatwootClient = overrides.chatwootClient || createChatwootClient();
  const chatwootService = overrides.chatwootService || createChatwootService({
    chatwootClient,
    conversationService,
    messageService,
    metaClient
  });
  const mediaService = overrides.mediaService || createMediaService({
    messageService,
    metaClient
  });
  const reminderService = overrides.reminderService || createReminderService({
    prisma,
    metaClient,
    messageService,
    conversationService
  });
  const chatOrchestrator = overrides.chatOrchestrator || createChatOrchestrator({
    openAIService,
    clientService,
    conversationService,
    messageService,
    bookingService,
    campaignService,
    alertService,
    serviceCatalogService,
    paymentProvider,
    metaClient,
    chatwootService,
    mediaService
  });

  return {
    prisma,
    clientService,
    conversationService,
    messageService,
    serviceCatalogService,
    bookingService,
    campaignService,
    alertService,
    openAIService,
    metaClient,
    chatwootClient,
    chatwootService,
    mediaService,
    paymentProvider,
    googleCalendar,
    reminderService,
    chatOrchestrator
  };
}

module.exports = { buildDependencies };
