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
  const normalized = text.toLowerCase();

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
  const normalized = text.toLowerCase();
  const faq = faqKnowledgeBase.find((item) =>
    normalized.includes(item.topic) ||
    (item.keywords || []).some((keyword) => normalized.includes(keyword))
  );

  return faq?.answer || null;
}

function normalizeIntentResult(rawResult, text) {
  const fallback = localIntentClassifier(text);

  if (!rawResult || typeof rawResult !== 'object') {
    return fallback;
  }

  const normalizedIntent = String(rawResult.intent || '').trim().toLowerCase();
  const allowedIntents = new Set(['booking', 'faq', 'cancel_booking', 'reschedule_booking', 'unknown']);

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
    const knownAnswer = resolveFaqAnswer(question);
    const serviceLines = services
      .map((service) => `${service.name}: ${service.description}. Precio ${service.price} ${service.currency}. Duracion ${service.durationMinutes} min.`)
      .join('\n');

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

  return {
    classifyIntent,
    answerFaq,
    craftBookingReply
  };
}

module.exports = { createOpenAIService };
