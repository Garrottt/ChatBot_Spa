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

  function isBotPaused(conversation) {
    return Boolean(conversation?.botPaused || conversation?.takenOverByAgent);
  }

  return {
    getOrCreateActiveConversation,
    updateConversation,
    mergeCollectedData,
    findByChatwootConversationId,
    findById,
    touchConversation,
    isBotPaused
  };
}

module.exports = { createConversationService };
