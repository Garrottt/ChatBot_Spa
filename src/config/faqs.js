const { env } = require('./env');

const faqKnowledgeBase = [
  {
    topic: 'nombre',
    keywords: ['nombre', 'llama', 'llaman', 'spa'],
    answer: `Somos ${env.spaName}. ${env.spaDescription}`
  },
  {
    topic: 'horarios',
    keywords: ['horario', 'horarios', 'atienden', 'abren', 'cierran'],
    answer: `Nuestro horario de atencion es ${env.spaBusinessHours}.`
  },
  {
    topic: 'ubicacion',
    keywords: ['ubicacion', 'direccion', 'donde', 'd\u00F3nde', 'estan', 'est\u00E1n', 'queda', 'encuentran'],
    answer: `Nos encontramos en ${env.spaLocation}.`
  },
  {
    topic: 'contacto',
    keywords: ['contacto', 'telefono', 'tel\u00E9fono', 'fono', 'llamar', 'whatsapp'],
    answer: `Puede contactarnos directamente en ${env.spaPhone}.`
  },
  {
    topic: 'instagram',
    keywords: ['instagram', 'redes', 'redes sociales', 'rrss'],
    answer: `Puede encontrarnos en Instagram en ${env.spaInstagram}.`
  },
  {
    topic: 'politicas',
    keywords: ['politicas', 'pol\u00EDticas', 'cancelacion', 'cancelaci\u00F3n', 'reagendar', 'reprogramar'],
    answer: env.spaPolicies
  },
  {
    topic: 'pagos',
    keywords: ['pago', 'pagos', 'tarjeta', 'transferencia', 'efectivo', 'debito', 'd\u00E9bito', 'credito', 'cr\u00E9dito'],
    answer: `Nuestros medios de pago son: ${env.spaPaymentMethods}.`
  },
  {
    topic: 'estacionamiento',
    keywords: ['estacionamiento', 'parking', 'auto', 'vehiculo', 'veh\u00EDculo'],
    answer: env.spaParkingInfo
  },
  {
    topic: 'preparacion',
    keywords: ['traer', 'llevar', 'preparar', 'preparacion', 'preparaci\u00F3n', 'antes del tratamiento'],
    answer: env.spaTreatmentPrep
  },
  {
    topic: 'edades',
    keywords: ['edad', 'edades', 'menores', 'ninos', 'ni\u00F1os', 'adultos'],
    answer: env.spaAgePolicy
  },
  {
    topic: 'informacion_general',
    keywords: ['servicios', 'experiencia', 'beneficios', 'tratamientos', 'ambiente', 'spa'],
    answer: env.spaFaqExtra
  }
];

function buildFaqContext() {
  return faqKnowledgeBase
    .map((faq) => `- ${faq.topic}: ${faq.answer}`)
    .join('\n');
}

module.exports = { faqKnowledgeBase, buildFaqContext };
