CREATE TABLE IF NOT EXISTS "Alert" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipientUserId" BIGINT,
    "recipientRole" TEXT,
    "clientId" TEXT,
    "bookingId" TEXT,
    "conversationId" TEXT,
    "actionUrl" TEXT,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Alert_eventKey_key" ON "Alert"("eventKey");
CREATE INDEX IF NOT EXISTS "Alert_recipientUserId_readAt_createdAt_idx" ON "Alert"("recipientUserId", "readAt", "createdAt");
CREATE INDEX IF NOT EXISTS "Alert_recipientRole_readAt_createdAt_idx" ON "Alert"("recipientRole", "readAt", "createdAt");
CREATE INDEX IF NOT EXISTS "Alert_bookingId_idx" ON "Alert"("bookingId");
CREATE INDEX IF NOT EXISTS "Alert_conversationId_idx" ON "Alert"("conversationId");
