CREATE TYPE "PaymentMethod" AS ENUM ('IN_PERSON_DEPOSIT', 'CARD_LINK');
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "PaymentProofStatus" AS ENUM ('PENDING', 'VALID', 'INVALID');

ALTER TABLE "Booking"
ADD COLUMN "paymentMethod" "PaymentMethod",
ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "paymentProofStatus" "PaymentProofStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN "depositAmount" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN "paymentProofReceivedAt" TIMESTAMP(3),
ADD COLUMN "paymentProofMetadata" JSONB,
ADD COLUMN "paymentProofValidation" JSONB;
