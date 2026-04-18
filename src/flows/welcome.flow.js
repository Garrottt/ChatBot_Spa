const { buildReply } = require('./helpers');

function createWelcomeFlow() {
  function buildMainMenuReply() {
    return buildReply({
      intent: 'menu',
      step: 'main_menu',
      text: '🌿 Spa Ikigai Ovalle\n\nEstoy aqui para ayudarle con su reserva, servicios y consultas.',
      collectedData: {},
      outbound: {
        kind: 'list',
        bodyText: '🌿 *Spa Ikigai Ovalle*\n\nBienvenido/a.\nSeleccione una opcion para continuar.\n\nSi desea volver aqui en cualquier momento, escriba "volver".',
        buttonText: 'Ver menu',
        sections: [
          {
            title: 'Opciones principales',
            rows: [
              { id: 'menu:services', title: 'Ver servicios', description: 'Tratamientos, duracion y valores' },
              { id: 'menu:book', title: 'Reservar cita', description: 'Agende su momento de bienestar' },
              { id: 'menu:consult', title: 'Consultas', description: 'Horarios, pagos, ubicacion y mas' },
              { id: 'menu:manage', title: 'Mis reservas', description: 'Revise o cancele sus citas' },
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
