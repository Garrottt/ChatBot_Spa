const { buildReply } = require('./helpers');

function createWelcomeFlow() {
  function buildMainMenuReply() {
    return buildReply({
      intent: 'menu',
      step: 'main_menu',
      text: 'Spa Ikigai Ovalle - Menu Principal',
      collectedData: {},
      outbound: {
        kind: 'list',
        bodyText: 'Spa Ikigai Ovalle - Menu Principal\n\nSeleccione una opcion del menu. Si en cualquier momento desea regresar aqui, escriba "volver".',
        buttonText: 'Abrir menu',
        sections: [
          {
            title: 'Opciones principales',
            rows: [
              { id: 'menu:services', title: 'Ver servicios', description: 'Conozca nuestros tratamientos de bienestar' },
              { id: 'menu:book', title: 'Reservar cita', description: 'Agende su momento de relax' },
              { id: 'menu:consult', title: 'Consultas', description: 'Preguntas sobre servicios, precios o informacion' },
              { id: 'menu:manage', title: 'Gestionar reservas', description: 'Ver o cancelar sus citas' },
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
