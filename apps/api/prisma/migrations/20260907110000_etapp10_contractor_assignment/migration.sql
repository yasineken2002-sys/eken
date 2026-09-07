-- ETAPP 10, PR 1 — HANTVERKARREGISTER OCH RIKTIG TILLDELNING
--
-- `MaintenanceTicket.assignedToId` var en naken `String?` utan relation.
-- Uppmätt före migrationen: NOLL skrivare i hela repot (ingen DTO, ingen
-- endpoint, ingen webbyta) och NOLL rader med värde i eken_dev. Det finns
-- alltså ingenting att backfilla, och kolumnen droppas INTE här — skuggagenten
-- läser den fortfarande, och att ta bort den i samma migration hade brutit
-- den utan att något prov sagt ifrån. Se TODO vid fältet i schema.prisma.
--
-- FK:erna är `SET NULL`, inte `CASCADE`: en raderad hantverkare eller
-- användare får inte ta ärendet med sig. Ärendet är historik; registret är ett
-- register.

-- AlterTable
ALTER TABLE "MaintenanceTicket" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedByUserId" TEXT,
ADD COLUMN     "assignedContractorId" TEXT;

-- CreateTable
CREATE TABLE "Contractor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "orgNumber" TEXT,
    "categories" "MaintenanceCategory"[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contractor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contractor_organizationId_idx" ON "Contractor"("organizationId");

-- CreateIndex
CREATE INDEX "Contractor_organizationId_isActive_idx" ON "Contractor"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "MaintenanceTicket_assignedContractorId_idx" ON "MaintenanceTicket"("assignedContractorId");

-- AddForeignKey
ALTER TABLE "Contractor" ADD CONSTRAINT "Contractor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_assignedContractorId_fkey" FOREIGN KEY ("assignedContractorId") REFERENCES "Contractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

