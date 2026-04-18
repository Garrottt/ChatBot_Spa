const dayjs = require('dayjs');

const { env } = require('../config/env');
const { logger } = require('../lib/logger');

function createReminderService({
  prisma,
  metaClient,
  messageService,
  conversationService
}) {
  // ─── Recordatorio de cita (24h antes) ────────────────────────────────────
  async function runPendingReminders(referenceDate = new Date()) {
    const now = dayjs(referenceDate);
    const threshold = now.add(env.bookingReminderHours, 'hour');
    const windowEnd = threshold.add(env.bookingReminderIntervalMinutes, 'minute');

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        reminderSentAt: null,
        scheduledAt: {
          gte: threshold.toDate(),
          lt: windowEnd.toDate()
        }
      },
      include: {
        client: true,
        service: true
      },
      orderBy: { scheduledAt: 'asc' }
    });

    let sent = 0;

    for (const booking of bookings) {
      const text = `📅 Recordatorio de cita\n\nTiene ${booking.service.name} agendado para el ${dayjs(booking.scheduledAt).format('YYYY-MM-DD HH:mm')}.\n\nSi necesita ayuda o desea cancelar, puede responder a este chat.`;
      await metaClient.sendTextMessage(booking.client.whatsappNumber, text);

      const conversation = await conversationService.getOrCreateActiveConversation(booking.clientId);
      await messageService.createOutgoingMessage({
        conversationId: conversation.id,
        clientId: booking.clientId,
        content: text,
        metadata: {
          intent: 'booking_reminder',
          step: 'reminder_sent',
          bookingId: booking.id
        }
      });

      await prisma.booking.update({
        where: { id: booking.id },
        data: { reminderSentAt: new Date() }
      });

      sent += 1;
    }

    logger.info('Processed booking reminders', {
      checkedAt: now.toISOString(),
      sent
    });

    return { sent };
  }

  // ─── Aviso de 5 minutos restantes ────────────────────────────────────────
  async function runHoldWarnings(referenceDate = new Date()) {
    const now = dayjs(referenceDate);

    // Ventana de 1 minuto centrada en los 5 minutos restantes.
    // Con un poll de 60s, cada booking entrara a esta ventana exactamente una vez.
    const windowStart = now.add(4, 'minute').add(30, 'second');
    const windowEnd = now.add(5, 'minute').add(30, 'second');

    const bookings = await prisma.booking.findMany({
      where: {
        status: 'PENDING',
        holdExpiresAt: {
          gte: windowStart.toDate(),
          lt: windowEnd.toDate()
        }
      },
      include: { client: true, service: true }
    });

    let sent = 0;

    for (const booking of bookings) {
      const expiresAt = dayjs(booking.holdExpiresAt).subtract(4, 'hour').format('HH:mm');
      const text = `⏳ *Aviso importante*\n\nLe quedan aproximadamente *5 minutos* para enviar su comprobante de pago y confirmar su cita de *${booking.service.name}*.\n\nSi no recibimos el comprobante antes de las ${expiresAt}, el horario sera liberado automaticamente.`;

      try {
        await metaClient.sendTextMessage(booking.client.whatsappNumber, text);

        const conversation = await conversationService.getOrCreateActiveConversation(booking.clientId);
        await messageService.createOutgoingMessage({
          conversationId: conversation.id,
          clientId: booking.clientId,
          content: text,
          metadata: {
            intent: 'hold_warning',
            step: 'awaiting_payment_proof',
            bookingId: booking.id
          }
        });

        sent += 1;
      } catch (error) {
        logger.warn('Failed to send hold warning', { bookingId: booking.id, error: error.message });
      }
    }

    logger.info('Processed hold warnings', { checkedAt: now.toISOString(), sent });

    return { sent };
  }

  // ─── Notificacion de expiración + expirar booking ────────────────────────
  async function runHoldExpiryNotifications(referenceDate = new Date()) {
    const now = dayjs(referenceDate);

    // Encontrar bookings PENDING que ya superaron su holdExpiresAt
    const expiredBookings = await prisma.booking.findMany({
      where: {
        status: 'PENDING',
        holdExpiresAt: { lte: now.toDate() }
      },
      include: { client: true, service: true }
    });

    let sent = 0;

    for (const booking of expiredBookings) {
      const conversation = await conversationService.getOrCreateActiveConversation(booking.clientId);
      const partialAmountPaid = (conversation.collectedData?.partialAmountPaid) || 0;

      const partialNote = partialAmountPaid > 0
        ? `\n\nDetectamos que habia realizado un abono parcial de *${partialAmountPaid} ${booking.service.currency}* para esta reserva. El equipo del spa se pondra en contacto con usted a la brevedad para solicitar sus datos bancarios y gestionar la devolucion de ese monto.`
        : '';

      const text = `⌛ Su tiempo para confirmar la cita de *${booking.service.name}* ya finalizo y el horario fue liberado.${partialNote}\n\nCuando lo desee, escriba *menu* para volver al menu principal y realizar una nueva reserva.`;

      try {
        await metaClient.sendTextMessage(booking.client.whatsappNumber, text);

        await messageService.createOutgoingMessage({
          conversationId: conversation.id,
          clientId: booking.clientId,
          content: text,
          metadata: {
            intent: 'hold_expired',
            step: 'main_menu',
            bookingId: booking.id
          }
        });

        sent += 1;
      } catch (error) {
        logger.warn('Failed to send hold expiry notification', { bookingId: booking.id, error: error.message });
      }
    }

    // Expirar todos los bookings encontrados
    if (expiredBookings.length > 0) {
      await prisma.booking.updateMany({
        where: {
          status: 'PENDING',
          holdExpiresAt: { lte: now.toDate() }
        },
        data: {
          status: 'CANCELLED',
          paymentStatus: 'EXPIRED'
        }
      });

      logger.info('Expired pending bookings', {
        checkedAt: now.toISOString(),
        expired: expiredBookings.length,
        notified: sent
      });
    }

    return { expired: expiredBookings.length, sent };
  }

  return {
    runPendingReminders,
    runHoldWarnings,
    runHoldExpiryNotifications
  };
}

module.exports = { createReminderService };
