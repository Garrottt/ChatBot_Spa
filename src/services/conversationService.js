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

  return {
    getOrCreateActiveConversation,
    updateConversation,
    mergeCollectedData,
    findByChatwootConversationId
  };
}

module.exports = { createConversationService };
