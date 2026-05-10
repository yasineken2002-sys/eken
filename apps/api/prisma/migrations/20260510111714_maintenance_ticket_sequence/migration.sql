-- CreateTable
CREATE TABLE "MaintenanceTicketSequence" (
    "organizationId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceTicketSequence_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "MaintenanceTicketSequence" ADD CONSTRAINT "MaintenanceTicketSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: starta sekvensen där befintliga ärenden slutar så nya nummer
-- inte krockar med historiskt utdelade. Räknar antal per organisation
-- och sätter lastNumber = count.
INSERT INTO "MaintenanceTicketSequence" ("organizationId", "lastNumber", "updatedAt")
SELECT "organizationId", COUNT(*)::int, NOW()
FROM "MaintenanceTicket"
GROUP BY "organizationId"
ON CONFLICT ("organizationId") DO NOTHING;
