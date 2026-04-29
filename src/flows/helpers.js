const dayjs = require('dayjs');

function buildReply({ intent, step, text, collectedData, lastBookingId, outbound }) {
  return {
    intent,
    step,
    text,
    collectedData,
    lastBookingId,
    outbound
  };
}

function normalizeCollectedData(value) {
  return value && typeof value === 'object' ? value : {};
}

function looksLikeName(text) {
  return /^[a-zA-Z\u00E1\u00E9\u00ED\u00F3\u00FA\u00C1\u00C9\u00CD\u00D3\u00DA\u00F1\u00D1 ]{3,}$/.test(String(text || '').trim());
}

function looksLikeFormalId(text) {
  return /^[0-9kK.\-]{6,15}$/.test(String(text || '').trim());
}

function looksLikeEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || '').trim());
}

function looksLikeDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text || '').trim());
}

function looksLikeTime(text) {
  return /^\d{2}:\d{2}$/.test(String(text || '').trim());
}

function normalizeDateInput(text) {
  return String(text || '').trim().split(/\s+/)[0];
}

function normalizeTimeInput(text) {
  return String(text || '').trim().slice(0, 5);
}

function parseSelectedAction(selectedId) {
  if (!selectedId || !selectedId.includes(':')) {
    return null;
  }

  const [type, ...rest] = selectedId.split(':');
  return {
    type,
    value: rest.join(':')
  };
}

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function resolveServiceSelection({ selectedAction, text, serviceCatalogService }) {
  if (selectedAction?.type === 'service') {
    return serviceCatalogService.getServiceById(selectedAction.value);
  }

  return serviceCatalogService.findServiceFromText(text);
}

function asksForBusinessInfo(text) {
  return /(horario|atencion|atienden|abren|cierran|ubicacion|direccion|donde|precio|precios|servicio|servicios|masaje|masajes|facial|faciales|limpieza|lifting|pestanas|depilacion|unas|tratamiento|tratamientos|nombre|spa|instagram|telefono|redes|estacionamiento|pago|tarjeta)/.test(normalizeSearchText(text));
}

function asksForOpeningHours(text) {
  return /(horario|horarios|atencion|atienden|abren|cierran|apertura|cierre)/.test(normalizeSearchText(text));
}

function wantsMainMenu(text) {
  return /^(volver|menu|men\u00FA|inicio|principal|0|salir)$/.test(String(text || '').trim().toLowerCase());
}

function asksForTimeRemaining(text) {
  return /(cu[aá]nto (tiempo|minutos?|me queda|falta)|tiempo (me queda|tengo|falta|queda)|minutos? (me quedan?|faltan?|tengo|quedan?)|cuanto (me queda|falta)|me (quedan?|faltan?) cuanto|tiempo restante|tiempo (disponible|limite)|cuando (vence|expira)|sigue (reservado|vigente|activo)|todav[ií]a (tengo|queda|hay))/.test(String(text || '').toLowerCase());
}

function asksForBookingStatus(text) {
  return /(mis reservas|mi reserva|mis horas|mi hora|mi cita|mis citas|tengo .*reserv|tengo .*hora|tengo .*cita|que hora (era|es)|cual es mi hora|cual era mi hora|me olvide.*hora|me olvid[eé].*cita|recuerdame.*hora|revis(a|e).*reserv|puedes revisar.*reserv|ver.*reservas?)/.test(
    String(text || '').toLowerCase()
  );
}

function inferDeterministicIntent(text, matchedService, selectedAction) {
  if (matchedService || selectedAction?.type === 'service' || selectedAction?.type === 'slot') {
    return 'booking';
  }

  if (selectedAction?.type === 'faq') {
    return 'faq';
  }

  if (selectedAction?.type === 'menu' && selectedAction.value === 'book') {
    return 'booking';
  }

  if (/(cancel|anular)/.test(text)) {
    return 'cancel_booking';
  }

  if (/(reagend|reprogram|cambiar hora|mover)/.test(text)) {
    return 'reschedule_booking';
  }

  if (asksForBookingStatus(text)) {
    return 'manage_bookings';
  }

  if (asksForOpeningHours(text)) {
    return 'faq';
  }

  if (/(reserv|agendar|agenda|hora|cita|turno)/.test(text)) {
    return 'booking';
  }

  if (asksForBusinessInfo(text)) {
    return 'faq';
  }

  return null;
}

function normalizeSlotValue(startsAt) {
  return dayjs(startsAt).format('HH:mm');
}

function inferPaymentMethod(text, selectedAction) {
  if (selectedAction?.type === 'payment') {
    if (selectedAction.value === 'card') {
      return 'CARD_LINK';
    }

    if (selectedAction.value === 'transfer') {
      return 'BANK_TRANSFER';
    }
  }

  const normalized = String(text || '').toLowerCase();
  if (/(debito|d\u00E9bito|credito|cr\u00E9dito|tarjeta|link|mercado pago)/.test(normalized)) {
    return 'CARD_LINK';
  }

  if (/(transferencia|transferir|transferencia bancaria|transferencia banco)/.test(normalized)) {
    return 'BANK_TRANSFER';
  }

  return null;
}

module.exports = {
  asksForBusinessInfo,
  asksForOpeningHours,
  asksForBookingStatus,
  asksForTimeRemaining,
  buildReply,
  inferDeterministicIntent,
  inferPaymentMethod,
  looksLikeDate,
  looksLikeEmail,
  looksLikeFormalId,
  looksLikeName,
  looksLikeTime,
  normalizeCollectedData,
  normalizeDateInput,
  normalizeSlotValue,
  normalizeTimeInput,
  parseSelectedAction,
  resolveServiceSelection,
  wantsMainMenu
};
