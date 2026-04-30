const OpenAI = require('openai');

const { faqKnowledgeBase, buildFaqContext } = require('../config/faqs');
const { spaAssistantSystemPrompt } = require('../config/prompts');
const { env } = require('../config/env');
const { logger } = require('./logger');

function extractJson(content) {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]);
  } catch (_error) {
    return null;
  }
}

function localIntentClassifier(text) {
  const normalized = normalizeSearchText(text);

  if (/(mis reservas|mi reserva|mis horas|mi hora|mi cita|mis citas|tengo .*reserv|tengo .*hora|tengo .*cita|que hora (era|es)|cual es mi hora|cual era mi hora|me olvide.*hora|me olvid[eé].*cita|recuerdame.*hora|revis(a|e).*reserv|puedes revisar.*reserv|ver.*reservas?)/.test(normalized)) {
    return { intent: 'manage_bookings', confidence: 0.9, entities: {} };
  }

  if (/(horario|horarios|atencion|atienden|abren|cierran|apertura|cierre)/.test(normalized)) {
    return { intent: 'faq', confidence: 0.9, entities: {} };
  }

  if (/(reserv|agendar|agenda|hora|cita|turno|quiero ir|quiero atenderme)/.test(normalized)) {
    return { intent: 'booking', confidence: 0.92, entities: {} };
  }

  if (/(cancel|anular)/.test(normalized)) {
    return { intent: 'cancel_booking', confidence: 0.88, entities: {} };
  }

  if (/(reagend|reprogram|cambiar hora|mover)/.test(normalized)) {
    return { intent: 'reschedule_booking', confidence: 0.88, entities: {} };
  }

  if (/(horario|ubicacion|ubicación|direccion|dirección|donde|dónde|precio|precios|servicio|servicios|spa|nombre|beneficios|tratamientos)/.test(normalized)) {
    return { intent: 'faq', confidence: 0.82, entities: {} };
  }

  return { intent: 'unknown', confidence: 0.4, entities: {} };
}

function resolveFaqAnswer(text) {
  const faq = resolveFaq(text);
  return faq?.answer || null;
}

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function resolveFaq(text) {
  const normalized = normalizeSearchText(text);
  return faqKnowledgeBase.find((item) =>
    normalized.includes(item.topic) ||
    (item.keywords || []).some((keyword) => normalized.includes(normalizeSearchText(keyword)))
  );
}

function formatServicePrice(amount, currency = 'CLP') {
  return `$${Number(amount || 0).toLocaleString('es-CL')} ${currency}`;
}

function findMatchingService(question, services) {
  const normalizedQuestion = normalizeSearchText(question);

  return services.find((service) => {
    const normalizedName = normalizeSearchText(service.name);
    const normalizedCode = normalizeSearchText(service.code || '');

    return normalizedQuestion.includes(normalizedName) || (normalizedCode && normalizedQuestion.includes(normalizedCode));
  }) || null;
}

function asksForServiceCatalog(question) {
  const normalized = normalizeSearchText(question);
  return /(que servicios|cuales servicios|servicios disponibles|que tratamientos|cuales tratamientos|precios|valores|catalogo|catalogo de servicios)/.test(normalized);
}

function buildDeterministicServiceAnswer(question, services) {
  const matchedService = findMatchingService(question, services);
  if (matchedService) {
    const descriptionBlock = matchedService.description
      ? `${matchedService.description}\n`
      : '';

    return `✨ ${matchedService.name}\n${descriptionBlock}⏱️ Duracion: ${matchedService.durationMinutes} minutos\n💰 Precio: ${formatServicePrice(matchedService.price, matchedService.currency)}`;
  }

  if (!asksForServiceCatalog(question)) {
    return null;
  }

  const catalog = services
    .map((service) => `✨ ${service.name}: ${formatServicePrice(service.price, service.currency)} - ${service.durationMinutes} min.`)
    .join('\n');

  return `Estos son nuestros servicios disponibles:\n\n${catalog}`;
}

function normalizeIntentResult(rawResult, text) {
  const fallback = localIntentClassifier(text);

  if (!rawResult || typeof rawResult !== 'object') {
    return fallback;
  }

  const normalizedIntent = String(rawResult.intent || '').trim().toLowerCase();
  const allowedIntents = new Set(['booking', 'faq', 'cancel_booking', 'reschedule_booking', 'manage_bookings', 'unknown']);

  return {
    intent: allowedIntents.has(normalizedIntent) ? normalizedIntent : fallback.intent,
    confidence: typeof rawResult.confidence === 'number' ? rawResult.confidence : fallback.confidence,
    entities: rawResult.entities && typeof rawResult.entities === 'object' ? rawResult.entities : {}
  };
}

function createOpenAIService() {
  const client = env.openAiApiKey ? new OpenAI({ apiKey: env.openAiApiKey }) : null;

  async function classifyIntent(text) {
    if (!client) {
      return localIntentClassifier(text);
    }

    try {
      const response = await client.responses.create({
        model: env.openAiModel,
        input: [
          { role: 'system', content: spaAssistantSystemPrompt.trim() },
          {
            role: 'user',
            content: `Clasifica este mensaje y responde SOLO JSON con forma {"intent":"","confidence":0,"entities":{}}:\n${text}`
          }
        ]
      });

      const parsed = extractJson(response.output_text || '');
      if (parsed?.intent) {
        const normalized = normalizeIntentResult(parsed, text);
        if (normalized.confidence >= 0.55) {
          return normalized;
        }
      }
    } catch (error) {
      logger.warn('OpenAI classifyIntent fallback triggered', { error: error.message });
    }

    return localIntentClassifier(text);
  }

  async function answerFaq(question, services) {
    const knownFaq = resolveFaq(question);
    const knownAnswer = knownFaq?.answer || null;
    const deterministicServiceAnswer = buildDeterministicServiceAnswer(question, services);
    const serviceLines = services
      .map((service) => `${service.name}: ${service.description}. Precio exacto ${formatServicePrice(service.price, service.currency)}. Duracion ${service.durationMinutes} min.`)
      .join('\n');

    if (knownAnswer && knownFaq.topic !== 'informacion_general') {
      return knownAnswer;
    }

    if (deterministicServiceAnswer) {
      return deterministicServiceAnswer;
    }

    if (!client) {
      return knownAnswer || `Puedo ayudarle con informacion del spa y reservas. Servicios disponibles:\n${serviceLines}`;
    }

    try {
      const response = await client.responses.create({
        model: env.openAiModel,
        input: [
          { role: 'system', content: spaAssistantSystemPrompt.trim() },
          {
            role: 'user',
            content: `Pregunta del cliente: ${question}
Informacion oficial del spa:
${buildFaqContext()}

Servicios disponibles:
${serviceLines}

Instrucciones:
- Responde con tono formal, cordial y profesional.
- No inventes informacion.
- Si no sabes algo, dilo claramente.
- Responde en no mas de 4 frases.`
          }
        ]
      });

      return response.output_text || knownAnswer || 'Con gusto puedo orientarle sobre nuestros servicios, horarios y reservas.';
    } catch (error) {
      logger.warn('OpenAI answerFaq fallback triggered', { error: error.message });
      return knownAnswer || `Puedo ayudarle con horarios, ubicacion, informacion del spa y reservas. Servicios disponibles:\n${serviceLines}`;
    }
  }

  async function craftBookingReply(context) {
    if (!client) {
      return context.fallbackMessage;
    }

    try {
      const response = await client.responses.create({
        model: env.openAiModel,
        input: [
          { role: 'system', content: spaAssistantSystemPrompt.trim() },
          {
            role: 'user',
            content: `Redacta una respuesta breve, formal y amable para el cliente usando esta informacion JSON:\n${JSON.stringify(context)}`
          }
        ]
      });

      return response.output_text || context.fallbackMessage;
    } catch (error) {
      logger.warn('OpenAI craftBookingReply fallback triggered', { error: error.message });
      return context.fallbackMessage;
    }
  }

  async function validatePaymentProof({
    imageBuffer,
    mimeType,
    amount,
    currency = 'CLP',
    expectedPayerName,
    expectedFormalId,
    paymentWindowStartsAt,
    paymentWindowEndsAt
  }) {
    if (!imageBuffer || !imageBuffer.length) {
      return {
        isValid: false,
        reason: 'No pude leer la imagen del comprobante.',
        detectedAmount: null,
        payerName: null,
        payerFormalId: null,
        paymentTimestamp: null,
        transactionId: null,
        confidence: 0
      };
    }

    if (!client) {
      return {
        isValid: false,
        reason: 'La validacion automatica del comprobante no esta disponible en este momento.',
        detectedAmount: null,
        payerName: null,
        payerFormalId: null,
        paymentTimestamp: null,
        transactionId: null,
        confidence: 0
      };
    }

    try {
      const response = await client.responses.create({
        model: env.openAiModel,
        input: [
          {
            role: 'system',
            content: 'Eres un extractor y validador estricto de comprobantes de pago. Responde SOLO JSON con forma {"isValid":boolean,"reason":"","detectedAmount":number|null,"payerName":string|null,"payerFormalId":string|null,"paymentTimestamp":string|null,"transactionId":string|null,"confidence":0}.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Analiza la imagen y responde siguiendo estas reglas estrictas:

REGLA 1 - isValid:
- isValid=true: solo si la imagen parece un comprobante o captura real de un pago y los datos visibles son compatibles con la reserva.
- isValid=false: si la imagen no parece un comprobante real, si el monto no coincide, si el pagador no coincide, si el RUT esperado no coincide o no aparece cuando deberia aparecer, o si la fecha/hora visible cae fuera de la ventana esperada.

REGLA 2 - Extraccion de datos:
- payerName: nombre del pagador o titular que aparece en el comprobante. Si hay varios nombres, conserva el nombre completo tal como aparece.
- payerFormalId: RUT o identificador si aparece visiblemente en la imagen. Si deberia estar y no aparece, devuelve null y explica el problema en reason.
- detectedAmount: monto numerico visible (sin simbolos). Si no coincide con el esperado, extraelo igual y marca isValid=false.
- paymentTimestamp: fecha y hora en formato ISO 8601 con offset de zona horaria. Para comprobantes chilenos con "Fecha" y "Hora" por separado, combinalas con el offset -04:00.
- transactionId: numero de solicitud, folio, numero de operacion, numero de transaccion, ID de operacion o cualquier identificador unico visible. Si no aparece ninguno, devuelve null.
- Si un campo no es legible, devuelve null para ese campo.

Datos de referencia para validar compatibilidad:
- Pagador esperado: ${expectedPayerName || 'No disponible'}
- RUT esperado: ${expectedFormalId || 'No disponible'}
- Monto esperado: ${amount || 'No disponible'} ${currency}
- Ventana de pago: desde ${paymentWindowStartsAt || 'No disponible'} hasta ${paymentWindowEndsAt || 'No disponible'}`
              },
              {
                type: 'input_image',
                image_url: `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`
              }
            ]
          }
        ]
      });

      const parsed = extractJson(response.output_text || '');
      if (!parsed || typeof parsed.isValid !== 'boolean') {
        return {
          isValid: false,
          reason: 'No pude validar el comprobante con suficiente claridad.',
          detectedAmount: null,
          payerName: null,
          payerFormalId: null,
          paymentTimestamp: null,
          transactionId: null,
          confidence: 0
        };
      }

      return {
        isValid: parsed.isValid,
        reason: parsed.reason || (parsed.isValid ? 'Comprobante valido.' : 'El comprobante no parece valido.'),
        detectedAmount: typeof parsed.detectedAmount === 'number' ? parsed.detectedAmount : null,
        payerName: typeof parsed.payerName === 'string' ? parsed.payerName : null,
        payerFormalId: typeof parsed.payerFormalId === 'string' ? parsed.payerFormalId : null,
        paymentTimestamp: typeof parsed.paymentTimestamp === 'string' ? parsed.paymentTimestamp : null,
        transactionId: typeof parsed.transactionId === 'string' ? parsed.transactionId.trim() : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0
      };
    } catch (error) {
      logger.warn('OpenAI validatePaymentProof fallback triggered', { error: error.message });
      return {
        isValid: false,
        reason: 'No pude validar el comprobante en este momento. Puede reenviarlo en unos instantes.',
        detectedAmount: null,
        payerName: null,
        payerFormalId: null,
        paymentTimestamp: null,
        transactionId: null,
        confidence: 0
      };
    }
  }

  return {
    classifyIntent,
    answerFaq,
    craftBookingReply,
    validatePaymentProof
  };
}

module.exports = { createOpenAIService };
