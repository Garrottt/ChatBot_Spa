ALTER TABLE "CampaignRecipient"
ADD COLUMN "providerMessageId" TEXT,
ADD COLUMN "deliveryStatus" TEXT,
ADD COLUMN "deliveredAt" TIMESTAMP(3),
ADD COLUMN "readAt" TIMESTAMP(3),
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "deliveryError" TEXT;
