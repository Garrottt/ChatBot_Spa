const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAvailableSlotsFromEvents, normalizeGooglePrivateKey } = require('../../src/lib/googleCalendar');

test('buildAvailableSlotsFromEvents returns available slots between busy events', () => {
  const slots = buildAvailableSlotsFromEvents({
    date: '2026-04-15',
    durationMinutes: 60,
    events: [
      {
        start: { dateTime: '2026-04-15T11:00:00.000Z' },
        end: { dateTime: '2026-04-15T12:00:00.000Z' }
      },
      {
        start: { dateTime: '2026-04-15T14:00:00.000Z' },
        end: { dateTime: '2026-04-15T15:00:00.000Z' }
      }
    ]
  });

  assert.ok(slots.length > 0);
  assert.equal(slots.some((slot) => slot.startsAt === '2026-04-15T11:00:00.000Z'), false);
  assert.equal(slots.some((slot) => slot.startsAt === '2026-04-15T14:00:00.000Z'), false);
});

test('normalizeGooglePrivateKey removes wrapping quotes and expands escaped newlines', () => {
  const normalized = normalizeGooglePrivateKey('"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"');

  assert.equal(
    normalized,
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  );
});
