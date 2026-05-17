const { randomUUID } = require('node:crypto');

function createAlertService({ prisma }) {
  async function createBookingConfirmedAlert(booking) {
    if (!booking) return;

    const dateLabel = formatBookingDate(booking.scheduledAt, booking.endAt);
    const clientName = booking.client?.name || 'Cliente';
    const serviceName = booking.service?.name || 'Servicio';
    const specialistName = booking.specialist?.name || 'Sin especialista asignado';

    await createForRecipients({
      eventKey: `booking:${booking.id}:confirmed`,
      type: 'booking_confirmed',
      title: 'Nueva reserva confirmada',
      body: `${clientName} confirmo ${serviceName} para ${dateLabel}. Especialista: ${specialistName}.`,
      clientId: booking.clientId,
      bookingId: booking.id,
      actionUrl: `/agenda?booking=${booking.id}`,
      metadata: {
        serviceName,
        specialistName,
        scheduledAt: booking.scheduledAt,
        endAt: booking.endAt
      },
      recipients: await bookingRecipients(booking)
    });
  }

  async function createBookingCancelledAlert(booking, source = 'system') {
    if (!booking) return;

    const dateLabel = formatBookingDate(booking.scheduledAt, booking.endAt);
    const clientName = booking.client?.name || 'Cliente';
    const serviceName = booking.service?.name || 'Servicio';
    const specialistName = booking.specialist?.name || 'Sin especialista asignado';

    await createForRecipients({
      eventKey: `booking:${booking.id}:cancelled`,
      type: 'booking_cancelled',
      title: 'Reserva cancelada',
      body: `${clientName} cancelo ${serviceName} para ${dateLabel}. Especialista: ${specialistName}.`,
      clientId: booking.clientId,
      bookingId: booking.id,
      actionUrl: `/agenda?booking=${booking.id}`,
      metadata: {
        source,
        serviceName,
        specialistName,
        scheduledAt: booking.scheduledAt,
        endAt: booking.endAt
      },
      recipients: await bookingRecipients(booking)
    });
  }

  async function createHumanRequestAlert({ client, conversation, messageText }) {
    if (!client || !conversation) return;

    await createForRecipients({
      eventKey: `conversation:${conversation.id}:human-requested`,
      type: 'human_requested',
      title: 'Cliente solicita atencion humana',
      body: `${client.name || client.whatsappNumber || 'Cliente'} pidio hablar con una persona.`,
      clientId: client.id,
      conversationId: conversation.id,
      actionUrl: `/conversations/${conversation.id}`,
      metadata: {
        messageText: messageText || null,
        whatsappNumber: client.whatsappNumber || null
      },
      recipients: await adminRecipients()
    });
  }

  async function bookingRecipients(booking) {
    const recipients = await adminRecipients();

    if (booking.specialist?.userId) {
      recipients.push({
        recipientUserId: booking.specialist.userId,
        recipientRole: 'SPECIALIST'
      });
    }

    return uniqueRecipients(recipients);
  }

  async function adminRecipients() {
    const users = await prisma.$queryRaw`
      SELECT id FROM users WHERE role = 'ADMIN'
    `.catch(() => []);

    return users.map((user) => ({
      recipientUserId: user.id,
      recipientRole: 'ADMIN'
    }));
  }

  async function createForRecipients({ eventKey, recipients, ...data }) {
    const unique = uniqueRecipients(recipients);
    if (!unique.length) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'Alert skipped because no recipients were found',
        eventKey,
        type: data.type
      }));
      return;
    }

    const rows = unique.map((recipient) => ({
      eventKey: `${eventKey}:user:${String(recipient.recipientUserId || recipient.recipientRole)}`,
      ...data,
      recipientUserId: recipient.recipientUserId || null,
      recipientRole: recipient.recipientRole || null
    }));

    if (prisma.alert?.createMany) {
      const result = await prisma.alert.createMany({
        data: rows,
        skipDuplicates: true
      });
      console.info(JSON.stringify({
        level: 'info',
        message: 'Alerts created',
        eventKey,
        type: data.type,
        attempted: rows.length,
        created: result.count
      }));
      return;
    }

    for (const row of rows) {
      await prisma.$executeRaw`
        INSERT INTO "Alert" (
          "id", "eventKey", "type", "title", "body", "recipientUserId", "recipientRole",
          "clientId", "bookingId", "conversationId", "actionUrl", "metadata", "createdAt", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${row.eventKey}, ${row.type}, ${row.title}, ${row.body},
          ${row.recipientUserId}, ${row.recipientRole}, ${row.clientId || null}, ${row.bookingId || null},
          ${row.conversationId || null}, ${row.actionUrl || null}, ${row.metadata || null}, NOW(), NOW()
        )
        ON CONFLICT ("eventKey") DO NOTHING
      `;
    }
    console.info(JSON.stringify({
      level: 'info',
      message: 'Alerts created with raw SQL fallback',
      eventKey,
      type: data.type,
      attempted: rows.length
    }));
  }

  function uniqueRecipients(recipients) {
    const seen = new Set();
    return (recipients || []).filter((recipient) => {
      const key = `${String(recipient.recipientUserId || '')}:${recipient.recipientRole || ''}`;
      if (!recipient.recipientUserId || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function formatBookingDate(start, end) {
    const formatter = new Intl.DateTimeFormat('es-CL', {
      timeZone: 'America/Santiago',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const timeFormatter = new Intl.DateTimeFormat('es-CL', {
      timeZone: 'America/Santiago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `${formatter.format(new Date(start))} - ${timeFormatter.format(new Date(end))}`;
  }

  return {
    createBookingConfirmedAlert,
    createBookingCancelledAlert,
    createHumanRequestAlert
  };
}

module.exports = { createAlertService };
