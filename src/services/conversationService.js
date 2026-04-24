const { env } = require('../config/env');

function createConversationService({ prisma }) {
  async function getOrCreateActiveConversation(clientId) {
    const existing = await prisma.conversation.findFirst({
      where: { clientId },
      orderBy: { updatedAt: 'desc' }
    });

    if (existing) {
      return existing;
    }

    return prisma.conversation.create({
      data: {
        clientId
      }
    });
  }

  async function updateConversation(id, data) {
    return prisma.conversation.update({
      where: { id },
      data
    });
  }

  async function mergeCollectedData(id, patch) {
    const existing = await prisma.conversation.findUnique({
      where: { id },
      select: { collectedData: true }
    });

    return prisma.conversation.update({
      where: { id },
      data: {
        collectedData: {
          ...(existing?.collectedData || {}),
          ...(patch || {})
        }
      }
    });
  }

  async function findByChatwootConversationId(chatwootConversationId) {
    if (!chatwootConversationId) {
      return null;
    }

    return prisma.conversation.findFirst({
      where: {
        collectedData: {
          path: ['chatwoot', 'conversationId'],
          equals: chatwootConversationId
        }
      },
      include: {
        client: true
      }
    });
  }

  async function findById(id, options = {}) {
    if (!id) {
      return null;
    }

    return prisma.conversation.findUnique({
      where: { id },
      ...options
    });
  }

  async function touchConversation(id) {
    return prisma.conversation.update({
      where: { id },
      data: {
        updatedAt: new Date()
      }
    });
  }

  async function resumeBotConversation(id) {
    return prisma.conversation.update({
      where: { id },
      data: {
        botPaused: false,
        takenOverByAgent: false,
        takenOverAt: null,
        takenOverByUserId: null
      }
    });
  }

  function isBotPaused(conversation) {
    return Boolean(conversation?.botPaused || conversation?.takenOverByAgent);
  }

  function shouldAutoResume(conversation) {
    if (!isBotPaused(conversation)) {
      return false;
    }

    const timeoutMinutes = Number(env.manualTakeoverTimeoutMinutes || 0);
    if (!conversation?.takenOverAt) {
      return true;
    }

    if (timeoutMinutes <= 0) {
      return false;
    }

    const takenOverAt = new Date(conversation.takenOverAt);
    if (Number.isNaN(takenOverAt.getTime())) {
      return true;
    }

    const elapsedMs = Date.now() - takenOverAt.getTime();
    return elapsedMs >= timeoutMinutes * 60 * 1000;
  }

  return {
    getOrCreateActiveConversation,
    updateConversation,
    mergeCollectedData,
    findByChatwootConversationId,
    findById,
    touchConversation,
    resumeBotConversation,
    isBotPaused,
    shouldAutoResume
  };
}

module.exports = { createConversationService };
