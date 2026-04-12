function createMessageService({ prisma }) {
  async function findIncomingByProviderId(providerId) {
    if (!providerId) {
      return null;
    }

    return prisma.message.findFirst({
      where: {
        providerId,
        direction: 'incoming'
      }
    });
  }

  async function createIncomingMessage({ conversationId, clientId, content, providerId, metadata }) {
    return prisma.message.create({
      data: {
        conversationId,
        clientId,
        content,
        providerId,
        metadata,
        direction: 'incoming',
        messageType: 'text'
      }
    });
  }

  async function createOutgoingMessage({ conversationId, clientId, content, metadata }) {
    return prisma.message.create({
      data: {
        conversationId,
        clientId,
        content,
        metadata,
        direction: 'outgoing',
        messageType: 'text'
      }
    });
  }

  return {
    findIncomingByProviderId,
    createIncomingMessage,
    createOutgoingMessage
  };
}

module.exports = { createMessageService };
