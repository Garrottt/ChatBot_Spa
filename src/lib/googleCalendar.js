const dayjs = require('dayjs');
const { google } = require('googleapis');

const { env } = require('../config/env');
const { AppError } = require('./errors');
const { logger } = require('./logger');

function createGoogleCalendarClient() {
  const normalizedPrivateKey = normalizeGooglePrivateKey(env.googlePrivateKey);
  const hasCredentials = Boolean(env.googleClientEmail && normalizedPrivateKey);

  function getCalendar() {
    if (!hasCredentials) {
      return null;
    }

    const auth = new google.auth.JWT({
      email: env.googleClientEmail,
      key: normalizedPrivateKey,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });

    return google.calendar({ version: 'v3', auth });
  }

  async function getAvailableSlots({ calendarId, date, durationMinutes }) {
    const selectedCalendarId = calendarId || env.googleDefaultCalendarId;

    if (!hasCredentials) {
      return buildDevelopmentSlots(date, durationMinutes);
    }

    const calendar = getCalendar();
    const startOfDay = buildChileDateTime(date, 9, 0);
    const endOfDay = buildChileDateTime(date, 20, 0);

    let response;

    try {
      response = await calendar.events.list({
        calendarId: selectedCalendarId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
    } catch (error) {
      logger.error('Google Calendar availability lookup failed', {
        calendarId: selectedCalendarId,
        error: error.message,
        status: error.code || error.response?.status || null
      });

      throw mapCalendarError(error, 'No pude consultar la agenda del spa en este momento.');
    }

    return buildAvailableSlotsFromEvents({
      date,
      durationMinutes,
      events: response.data.items || []
    });
  }

  async function createEvent({ calendarId, booking, client, service }) {
    const selectedCalendarId = calendarId || service.calendarId || env.googleDefaultCalendarId;

    if (!hasCredentials) {
      return { id: `dev-event-${booking.id}` };
    }

    const calendar = getCalendar();
    let response;

    try {
      response = await calendar.events.insert({
        calendarId: selectedCalendarId,
        requestBody: {
          summary: `${service.name} - ${client.name || client.whatsappNumber}`,
          description: `Reserva creada desde WhatsApp.\nCliente: ${client.name || 'Sin nombre'}\nRUT/ID: ${client.formalId || 'Sin registrar'}`,
          start: {
            dateTime: booking.scheduledAt.toISOString(),
            timeZone: env.googleTimezone
          },
          end: {
            dateTime: booking.endAt.toISOString(),
            timeZone: env.googleTimezone
          }
        }
      });
    } catch (error) {
      logger.error('Google Calendar event creation failed', {
        calendarId: selectedCalendarId,
        error: error.message,
        status: error.code || error.response?.status || null
      });

      throw mapCalendarError(error, 'No pude confirmar la reserva en la agenda del spa.');
    }

    return response.data;
  }

  async function getEvent({ calendarId, eventId }) {
    const selectedCalendarId = calendarId || env.googleDefaultCalendarId;

    if (!eventId) {
      return null;
    }

    if (!hasCredentials) {
      return eventId.startsWith('dev-event-')
        ? { id: eventId, status: 'confirmed' }
        : null;
    }

    const calendar = getCalendar();

    try {
      const response = await calendar.events.get({
        calendarId: selectedCalendarId,
        eventId
      });

      return response.data;
    } catch (error) {
      const status = error.code || error.response?.status || null;

      if (status === 404) {
        return null;
      }

      logger.error('Google Calendar event lookup failed', {
        calendarId: selectedCalendarId,
        eventId,
        error: error.message,
        status
      });

      throw mapCalendarError(error, 'No pude revisar la reserva en Google Calendar.');
    }
  }

  async function cancelEvent({ calendarId, eventId }) {
    if (!eventId || !hasCredentials) {
      return { skipped: true };
    }

    const calendar = getCalendar();
    try {
      await calendar.events.delete({
        calendarId: calendarId || env.googleDefaultCalendarId,
        eventId
      });
    } catch (error) {
      logger.error('Google Calendar event deletion failed', {
        calendarId: calendarId || env.googleDefaultCalendarId,
        eventId,
        error: error.message,
        status: error.code || error.response?.status || null
      });

      throw mapCalendarError(error, 'No pude cancelar la reserva en la agenda del spa.');
    }

    return { ok: true };
  }

  return {
    getAvailableSlots,
    createEvent,
    getEvent,
    cancelEvent
  };
}

function buildDevelopmentSlots(date, durationMinutes) {
  const startHour = 10;
  const slots = [];

  for (let index = 0; index < 5; index += 1) {
    const start = buildChileDateTime(date, startHour + index * 2, 0);
    slots.push({
      startsAt: start.toISOString(),
      endsAt: start.add(durationMinutes, 'minute').toISOString()
    });
  }

  return slots;
}

function buildAvailableSlotsFromEvents({ date, durationMinutes, events }) {
  const openingHour = 9;
  const closingHour = 20;
  const slots = [];
  let cursor = buildChileDateTime(date, openingHour, 0);
  const dayEnd = buildChileDateTime(date, closingHour, 0);
  const normalizedEvents = events
    .map((event) => ({
      start: dayjs(event.start?.dateTime || event.start?.date),
      end: dayjs(event.end?.dateTime || event.end?.date)
    }))
    .sort((left, right) => left.start.valueOf() - right.start.valueOf());

  for (const event of normalizedEvents) {
    while (cursor.add(durationMinutes, 'minute').valueOf() <= event.start.valueOf()) {
      slots.push({
        startsAt: cursor.toISOString(),
        endsAt: cursor.add(durationMinutes, 'minute').toISOString()
      });
      cursor = cursor.add(durationMinutes, 'minute');
    }

    if (cursor.isBefore(event.end)) {
      cursor = event.end;
    }
  }

  while (cursor.add(durationMinutes, 'minute').valueOf() <= dayEnd.valueOf()) {
    slots.push({
      startsAt: cursor.toISOString(),
      endsAt: cursor.add(durationMinutes, 'minute').toISOString()
    });
    cursor = cursor.add(durationMinutes, 'minute');
  }

  logger.info('Generated slots from Google Calendar', { date, count: slots.length });
  return slots;
}

module.exports = {
  createGoogleCalendarClient,
  buildAvailableSlotsFromEvents,
  normalizeGooglePrivateKey
};

function normalizeGooglePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const withoutWrappingQuotes = raw
    .replace(/^"/, '')
    .replace(/"$/, '')
    .trim();

  return withoutWrappingQuotes
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();
}

function buildChileDateTime(date, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return dayjs(`${date}T${hh}:${mm}:00-04:00`);
}

function mapCalendarError(error, fallbackMessage) {
  const status = error.code || error.response?.status || 500;

  if (status === 404) {
    return new AppError(
      'No pude acceder al calendario configurado. Revisa GOOGLE_CALENDAR_DEFAULT_ID y que el calendario este compartido con la cuenta de servicio.',
      503
    );
  }

  if (status === 401 || status === 403) {
    return new AppError(
      'No tengo permisos para usar Google Calendar. Revisa las credenciales y el acceso compartido del calendario.',
      503
    );
  }

  return new AppError(fallbackMessage, 503);
}
