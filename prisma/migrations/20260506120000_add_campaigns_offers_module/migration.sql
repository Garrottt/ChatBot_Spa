-- Client marketing fields
ALTER TABLE "Client"
  ADD COLUMN "marketingOptOut" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "marketingOptOutAt" TIMESTAMP(3),
  ADD COLUMN "lastInteractionAt" TIMESTAMP(3),
  ADD COLUMN "lastBookingAt" TIMESTAMP(3),
  ADD COLUMN "firstBookingAt" TIMESTAMP(3);

-- Booking attribution and commercial price snapshot
ALTER TABLE "Booking"
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "offerId" TEXT,
  ADD COLUMN "finalPrice" INTEGER,
  ADD COLUMN "offerDiscountSnapshot" JSONB;

-- Offer discount type enum
CREATE TYPE "OfferDiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'CUSTOM_TEXT');

CREATE TABLE "Offer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "serviceId" TEXT,
  "specialistId" TEXT,
  "discountType" "OfferDiscountType" NOT NULL,
  "discountValue" INTEGER,
  "customText" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "maxRedemptions" INTEGER,
  "usedRedemptions" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- Campaign enums and tables
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT', 'PAUSED', 'CANCELLED', 'FINISHED');
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'RESPONDED', 'BOOKED', 'OPTED_OUT', 'SKIPPED');

CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "offerId" TEXT NOT NULL,
  "segmentType" TEXT NOT NULL,
  "segmentFilter" JSONB,
  "messageTemplate" TEXT NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "sentAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignRecipient" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "bookingId" TEXT,
  "conversationId" TEXT,
  "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "bookedAt" TIMESTAMP(3),
  "failedReason" TEXT,
  "messageSnapshot" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignRecipient_campaignId_clientId_key" ON "CampaignRecipient"("campaignId", "clientId");

ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Offer_specialistId_fkey" FOREIGN KEY ("specialistId") REFERENCES "Specialist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignRecipient"
  ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignRecipient_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
