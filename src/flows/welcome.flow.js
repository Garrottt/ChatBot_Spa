const { env } = require('../config/env');
const { buildReply } = require('./helpers');

function createWelcomeFlow() {
  function buildMainMenuReply() {
    const businessName = env.spaName || 'Spa La Roca';

    return buildReply({
      intent: 'menu',
      step: 'main_menu',
      text: `${businessName}\n\nHola, soy el asistente virtual. Puedo ayudarle a ver servicios, reservar una cita o resolver sus dudas.`,
      collectedData: { campaignContext: null },
      outbound: {
        kind: 'list',
        bodyText: `*${businessName}*\n\nBienvenido/a. Elija una opcion para continuar.\n\nPuede escribir "volver" en cualquier momento para regresar a este menu.`,
        buttonText: 'Ver menu',
        sections: [
          {
            title: 'Opciones principales',
            rows: [
              { id: 'menu:services', title: 'Ver servicios', description: 'Duracion, detalle y valores' },
              { id: 'menu:book', title: 'Reservar cita', description: 'Buscar fecha y horario disponible' },
              { id: 'menu:consult', title: 'Consultas', description: 'Horarios, pagos, ubicacion y mas' },
              { id: 'menu:manage', title: 'Mis reservas', description: 'Revisar o cancelar citas activas' },
              { id: 'menu:exit', title: 'Salir', description: 'Cerrar la conversacion por ahora' }
            ]
          }
        ]
      }
    });
  }

  return {
    buildMainMenuReply
  };
}

module.exports = { createWelcomeFlow };
