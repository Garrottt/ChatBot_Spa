const { buildReply } = require('./helpers');

function createFaqFlow({ openAIService, serviceCatalogService }) {
  function buildConsultationWelcomeReply(collectedData) {
    return buildReply({
      intent: 'faq',
      step: 'consultation_open',
      text: '💬 Puede hacerme cualquier pregunta sobre el spa.\n\nEstoy aqui para ayudarle con servicios, horarios, reservas, pagos y mas.',
      collectedData
    });
  }

  async function answerQuestion(question, collectedData) {
    const services = await serviceCatalogService.listActiveServices();
    const service = collectedData?.serviceId
      ? services.find((item) => item.id === collectedData.serviceId) || null
      : null;
    const text = await openAIService.answerFaq(question, services, { service });
    const outbound = service
      ? {
          kind: 'buttons',
          bodyText: `${text}\n\n¿Que desea hacer con ${service.name}?`,
          buttons: [
            { id: `bookservice:${service.id}`, title: 'Reservar' },
            { id: `askservice:${service.id}`, title: 'Otra consulta' }
          ]
        }
      : undefined;

    return buildReply({
      intent: 'faq',
      step: 'answered',
      text,
      collectedData,
      outbound
    });
  }

  async function buildFaqReply(topic, collectedData) {
    const textByTopic = {
      horarios: 'cuales son los horarios del spa',
      ubicacion: 'donde se encuentra el spa',
      servicios: 'que servicios ofrecen',
      contacto: 'cual es el telefono de contacto',
      politicas: 'cual es la politica de cancelacion',
      instagram: 'cuales son sus redes sociales',
      pagos: 'cuales son los medios de pago',
      estacionamiento: 'tienen estacionamiento'
    };

    return answerQuestion(textByTopic[topic] || topic, collectedData);
  }

  return {
    answerQuestion,
    buildConsultationWelcomeReply,
    buildFaqReply
  };
}

module.exports = { createFaqFlow };
