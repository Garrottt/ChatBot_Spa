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

  return {
    getOrCreateActiveConversation,
    updateConversation
  };
}

module.exports = { createConversationService };
