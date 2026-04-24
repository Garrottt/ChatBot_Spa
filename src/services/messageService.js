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

  async function createIncomingMessage({ conversationId, clientId, content, providerId, metadata, messageType = 'text' }) {
    return prisma.message.create({
      data: {
        conversationId,
        clientId,
        content,
        providerId,
        metadata,
        direction: 'incoming',
        messageType
      }
    });
  }

  async function createOutgoingMessage({ conversationId, clientId, content, metadata, providerId = null, messageType = 'text' }) {
    return prisma.message.create({
      data: {
        conversationId,
        clientId,
        content,
        providerId,
        metadata,
        direction: 'outgoing',
        messageType
      }
    });
  }

  async function findOutgoingByProviderId(providerId) {
    if (!providerId) {
      return null;
    }

    return prisma.message.findFirst({
      where: {
        providerId,
        direction: 'outgoing'
      }
    });
  }

  async function findById(id) {
    if (!id) {
      return null;
    }

    return prisma.message.findUnique({
      where: { id }
    });
  }

  async function updateMessage(id, data) {
    return prisma.message.update({
      where: { id },
      data
    });
  }

  return {
    findIncomingByProviderId,
    createIncomingMessage,
    createOutgoingMessage,
    findOutgoingByProviderId,
    findById,
    updateMessage
  };
}

module.exports = { createMessageService };
