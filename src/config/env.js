const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  META_VERIFY_TOKEN: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_ACCESS_TOKEN: z.string().default(''),
  META_PHONE_NUMBER_ID: z.string().default(''),
  META_API_VERSION: z.string().default('v21.0'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  GOOGLE_CALENDAR_CLIENT_EMAIL: z.string().default(''),
  GOOGLE_CALENDAR_PRIVATE_KEY: z.string().default(''),
  GOOGLE_CALENDAR_DEFAULT_ID: z.string().default('primary'),
  GOOGLE_CALENDAR_TIMEZONE: z.string().default('America/Santiago'),
  PAYMENT_BASE_URL: z.string().url().default('https://pagos.tu-spa.cl'),
  PAYMENT_PROVIDER_NAME: z.string().default('manual-link'),
  MERCADOPAGO_ACCESS_TOKEN: z.string().default(''),
  MERCADOPAGO_PUBLIC_BASE_URL: z.string().url().default('https://example.com'),
  MERCADOPAGO_WEBHOOK_URL: z.string().url().optional(),
  SPA_NAME: z.string().default('Spa Ikigai Ovalle'),
  SPA_BRAND_TONE: z.string().default('formal, cordial y profesional'),
  SPA_DESCRIPTION: z.string().default('Centro de bienestar enfocado en relajacion, cuidado personal y experiencias de descanso integral.'),
  SPA_LOCATION: z.string().default('Pje. Cecilia Videla 755, 1840000 Ovalle, Coquimbo'),
  SPA_PHONE: z.string().default('9 8869 8666'),
  SPA_BUSINESS_HOURS: z.string().default('Lunes a Sabado de 09:00 a 20:00'),
  SPA_POLICIES: z.string().default('Las reservas pueden reagendarse con 24 horas de anticipacion.'),
  SPA_FAQ_EXTRA: z.string().default('Ofrecemos tratamientos de bienestar y belleza con enfoque personalizado para cada cliente.'),
  SPA_INSTAGRAM: z.string().default('https://www.instagram.com/spa.ikigai.ovalle/'),
  SPA_PAYMENT_METHODS: z.string().default('Efectivo, transferencia y tarjetas de debito/credito'),
  SPA_PARKING_INFO: z.string().default('Contamos con estacionamiento disponible para la comodidad de nuestros clientes.'),
  SPA_TREATMENT_PREP: z.string().default('Solo necesita venir con disposicion para relajarse. Nosotros nos encargamos del resto, incluyendo toallas, productos y ambiente preparado.'),
  SPA_AGE_POLICY: z.string().default('La mayoria de los tratamientos estan orientados a adultos. Para menores de edad, recomendamos consultar previamente.')
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables', parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

const env = {
  nodeEnv: parsedEnv.data.NODE_ENV,
  port: parsedEnv.data.PORT,
  databaseUrl: parsedEnv.data.DATABASE_URL,
  metaVerifyToken: parsedEnv.data.META_VERIFY_TOKEN,
  metaAppSecret: parsedEnv.data.META_APP_SECRET,
  metaAccessToken: parsedEnv.data.META_ACCESS_TOKEN,
  metaPhoneNumberId: parsedEnv.data.META_PHONE_NUMBER_ID,
  metaApiVersion: parsedEnv.data.META_API_VERSION,
  openAiApiKey: parsedEnv.data.OPENAI_API_KEY,
  openAiModel: parsedEnv.data.OPENAI_MODEL,
  googleClientEmail: parsedEnv.data.GOOGLE_CALENDAR_CLIENT_EMAIL,
  googlePrivateKey: parsedEnv.data.GOOGLE_CALENDAR_PRIVATE_KEY,
  googleDefaultCalendarId: parsedEnv.data.GOOGLE_CALENDAR_DEFAULT_ID,
  googleTimezone: parsedEnv.data.GOOGLE_CALENDAR_TIMEZONE,
  paymentBaseUrl: parsedEnv.data.PAYMENT_BASE_URL,
  paymentProviderName: parsedEnv.data.PAYMENT_PROVIDER_NAME,
  mercadoPagoAccessToken: parsedEnv.data.MERCADOPAGO_ACCESS_TOKEN,
  mercadoPagoPublicBaseUrl: parsedEnv.data.MERCADOPAGO_PUBLIC_BASE_URL,
  mercadoPagoWebhookUrl: parsedEnv.data.MERCADOPAGO_WEBHOOK_URL || null,
  spaName: parsedEnv.data.SPA_NAME,
  spaBrandTone: parsedEnv.data.SPA_BRAND_TONE,
  spaDescription: parsedEnv.data.SPA_DESCRIPTION,
  spaLocation: parsedEnv.data.SPA_LOCATION,
  spaPhone: parsedEnv.data.SPA_PHONE,
  spaBusinessHours: parsedEnv.data.SPA_BUSINESS_HOURS,
  spaPolicies: parsedEnv.data.SPA_POLICIES,
  spaFaqExtra: parsedEnv.data.SPA_FAQ_EXTRA,
  spaInstagram: parsedEnv.data.SPA_INSTAGRAM,
  spaPaymentMethods: parsedEnv.data.SPA_PAYMENT_METHODS,
  spaParkingInfo: parsedEnv.data.SPA_PARKING_INFO,
  spaTreatmentPrep: parsedEnv.data.SPA_TREATMENT_PREP,
  spaAgePolicy: parsedEnv.data.SPA_AGE_POLICY
};

module.exports = { env };
