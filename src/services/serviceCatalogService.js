const { AppError } = require('../lib/errors');

function createServiceCatalogService({ prisma }) {
  async function listActiveServices() {
    return prisma.service.findMany({
      where: { active: true },
      orderBy: { name: 'asc' }
    });
  }

  async function getServiceById(serviceId) {
    const service = await prisma.service.findUnique({
      where: { id: serviceId }
    });

    if (!service || !service.active) {
      throw new AppError('Service not found', 404);
    }

    return service;
  }

  async function findServiceFromText(text) {
    const services = await listActiveServices();
    const normalized = text.toLowerCase();

    return services.find((service) =>
      normalized.includes(service.name.toLowerCase()) ||
      normalized.includes(service.code.toLowerCase())
    ) || null;
  }

  return {
    listActiveServices,
    getServiceById,
    findServiceFromText
  };
}

module.exports = { createServiceCatalogService };
