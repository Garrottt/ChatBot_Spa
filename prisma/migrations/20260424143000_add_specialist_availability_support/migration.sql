CREATE TABLE IF NOT EXISTS "Specialist" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "specialty" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "workSchedule" TEXT,
  CONSTRAINT "Specialist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Availability" (
  "id" TEXT NOT NULL,
  "specialistId" TEXT NOT NULL,
  "dayOfWeek" SMALLINT NOT NULL,
  "startTime" TIME(0) NOT NULL,
  "endTime" TIME(0) NOT NULL,
  CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "_SpecialistServices" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_SpecialistServices_pkey" PRIMARY KEY ("A", "B")
);

ALTER TABLE "Availability"
DROP CONSTRAINT IF EXISTS "Availability_specialistId_fkey";

ALTER TABLE "Availability"
ADD CONSTRAINT "Availability_specialistId_fkey"
FOREIGN KEY ("specialistId") REFERENCES "Specialist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_SpecialistServices"
DROP CONSTRAINT IF EXISTS "_SpecialistServices_A_fkey";

ALTER TABLE "_SpecialistServices"
ADD CONSTRAINT "_SpecialistServices_A_fkey"
FOREIGN KEY ("A") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_SpecialistServices"
DROP CONSTRAINT IF EXISTS "_SpecialistServices_B_fkey";

ALTER TABLE "_SpecialistServices"
ADD CONSTRAINT "_SpecialistServices_B_fkey"
FOREIGN KEY ("B") REFERENCES "Specialist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Booking"
ADD COLUMN IF NOT EXISTS "specialistId" TEXT;

ALTER TABLE "Booking"
DROP CONSTRAINT IF EXISTS "Booking_specialistId_fkey";

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_specialistId_fkey"
FOREIGN KEY ("specialistId") REFERENCES "Specialist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Availability_specialistId_dayOfWeek_idx"
ON "Availability" ("specialistId", "dayOfWeek");

CREATE INDEX IF NOT EXISTS "Booking_specialistId_scheduledAt_idx"
ON "Booking" ("specialistId", "scheduledAt");
