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
    keywords: ['ubicacion', 'direccion', 'donde', 'dónde', 'estan', 'están', 'queda', 'encuentran'],
    answer: `Nos encontramos en ${env.spaLocation}.`
  },
  {
    topic: 'contacto',
    keywords: ['contacto', 'telefono', 'teléfono', 'fono', 'llamar', 'whatsapp'],
    answer: `Puede contactarnos directamente en ${env.spaPhone}.`
  },
  {
    topic: 'instagram',
    keywords: ['instagram', 'redes', 'redes sociales', 'rrss'],
    answer: `Puede encontrarnos en Instagram en ${env.spaInstagram}.`
  },
  {
    topic: 'politicas',
    keywords: ['politicas', 'políticas', 'cancelacion', 'cancelación', 'reagendar', 'reprogramar'],
    answer: env.spaPolicies
  },
  {
    topic: 'pagos',
    keywords: ['pago', 'pagos', 'tarjeta', 'transferencia', 'efectivo', 'debito', 'débito', 'credito', 'crédito'],
    answer: `Nuestros medios de pago son: ${env.spaPaymentMethods}.`
  },
  {
    topic: 'estacionamiento',
    keywords: ['estacionamiento', 'parking', 'auto', 'vehiculo', 'vehículo'],
    answer: env.spaParkingInfo
  },
  {
    topic: 'preparacion',
    keywords: ['traer', 'llevar', 'preparar', 'preparacion', 'preparación', 'antes del tratamiento'],
    answer: env.spaTreatmentPrep
  },
  {
    topic: 'edades',
    keywords: ['edad', 'edades', 'menores', 'ninos', 'niños', 'adultos'],
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
