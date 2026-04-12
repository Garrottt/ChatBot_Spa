function createClientService({ prisma }) {
  async function findOrCreateByWhatsappNumber({ whatsappNumber, name }) {
    const existing = await prisma.client.findUnique({
      where: { whatsappNumber }
    });

    if (existing) {
      if (!existing.name && name) {
        return prisma.client.update({
          where: { id: existing.id },
          data: { name }
        });
      }

      return existing;
    }

    return prisma.client.create({
      data: {
        whatsappNumber,
        name: name || null
      }
    });
  }

  async function updateClient(clientId, data) {
    return prisma.client.update({
      where: { id: clientId },
      data
    });
  }

  async function getClientById(clientId) {
    return prisma.client.findUnique({
      where: { id: clientId }
    });
  }

  return {
    findOrCreateByWhatsappNumber,
    updateClient,
    getClientById
  };
}

module.exports = { createClientService };
