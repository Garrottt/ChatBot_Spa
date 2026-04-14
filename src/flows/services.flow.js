const { buildReply } = require('./helpers');

function createServicesFlow({ serviceCatalogService }) {
  async function createServiceListOutbound() {
    const services = await serviceCatalogService.listActiveServices();
    return {
      kind: 'list',
      bodyText: '✨ Estos son nuestros servicios disponibles. Presiona uno para ver sus detalles.',
      buttonText: 'Ver servicios',
      sections: [
        {
          title: 'Servicios del spa',
          rows: services.slice(0, 10).map((service) => ({
            id: `service:${service.id}`,
            title: service.name,
            description: `${service.durationMinutes} min - ${service.price} ${service.currency}`
          }))
        }
      ]
    };
  }

  // Muestra el detalle de un servicio con botones para reservar o consultar
  function buildServiceDetailReply(service, collectedData) {
    const priceFormatted = Number(service.price).toLocaleString('es-CL');
    const descriptionBlock = service.description
      ? `\n\n📋 ${service.description}`
      : '';

    const detailText = `✨ *${service.name}*${descriptionBlock}\n\n⏱️ *Duracion:* ${service.durationMinutes} minutos\n💰 *Precio:* $${priceFormatted} ${service.currency}`;

    return buildReply({
      intent: 'services',
      step: 'service_detail',
      text: detailText,
      collectedData: {
        ...collectedData,
        serviceId: service.id
      },
      outbound: {
        kind: 'buttons',
        bodyText: `¿Que deseas hacer con *${service.name}*?`,
        buttons: [
          { id: `bookservice:${service.id}`, title: '📅 Reservar' },
          { id: `askservice:${service.id}`, title: '💬 Consultas' }
        ]
      }
    });
  }

  async function buildServiceListReply(collectedData) {
    const services = await serviceCatalogService.listActiveServices();
    const summary = services
      .map((service) => `*${service.name}:* ${service.description} (${service.durationMinutes} min, $${Number(service.price).toLocaleString('es-CL')} ${service.currency})`)
      .join('\n\n');

    return buildReply({
      intent: 'services',
      step: 'services_list',
      text: `✨ Estos son nuestros servicios disponibles:\n\n${summary}`,
      collectedData,
      outbound: await createServiceListOutbound()
    });
  }

  return {
    buildServiceDetailReply,
    buildServiceListReply,
    createServiceListOutbound
  };
}

module.exports = { createServicesFlow };
