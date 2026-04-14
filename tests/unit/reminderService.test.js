const test = require('node:test');
const assert = require('node:assert/strict');

const { createReminderService } = require('../../src/services/reminderService');

test('runPendingReminders sends reminders and marks bookings as reminded', async () => {
  const updates = [];
  const sentMessages = [];
  const outgoingMessages = [];

  const service = createReminderService({
    prisma: {
      booking: {
        findMany: async () => ([
          {
            id: 'booking-1',
            clientId: 'client-1',
            scheduledAt: new Date('2026-04-14T15:00:00.000Z'),
            client: { whatsappNumber: '56911111111' },
            service: { name: 'Masaje relajante' }
          }
        ]),
        update: async (payload) => {
          updates.push(payload);
          return payload;
        }
      }
    },
    metaClient: {
      sendTextMessage: async (to, text) => {
        sentMessages.push({ to, text });
      }
    },
    messageService: {
      createOutgoingMessage: async (payload) => {
        outgoingMessages.push(payload);
        return payload;
      }
    },
    conversationService: {
      getOrCreateActiveConversation: async () => ({ id: 'conv-1' })
    }
  });

  const result = await service.runPendingReminders(new Date('2026-04-13T15:00:00.000Z'));

  assert.equal(result.sent, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Recordatorio de cita/i);
  assert.equal(outgoingMessages.length, 1);
  assert.equal(outgoingMessages[0].metadata.intent, 'booking_reminder');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, 'booking-1');
});
