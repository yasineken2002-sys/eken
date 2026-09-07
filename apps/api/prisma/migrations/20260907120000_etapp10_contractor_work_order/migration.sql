-- ETAPP 10, PR 2 — ARBETSORDER TILL HANTVERKARE
--
-- Skild från tilldelningen med flit. `assignedContractorId` säger VEM som ska
-- göra jobbet; den här tabellen säger att någon FAKTISKT KONTAKTATS, när, av
-- vem, och vad hen svarade. Det är den skillnaden som avgör om något går att
-- ta tillbaka: en tilldelning är en anteckning, en arbetsorder har lämnat huset.
--
-- `responseTokenHash` är sha256 av ett 32-bytes slumpat token. RÅVÄRDET LAGRAS
-- ALDRIG — samma form som aktiverings- och återställningstoken i
-- TenantAuthService. En databasdump ger alltså inga användbara svarslänkar.
--
-- Unikt index på hashen: uppslaget vid svar sker på den, och två ordrar får
-- aldrig dela token.
--
-- `contractorId` är RESTRICT, inte SetNull: en skickad arbetsorder är ett bevis
-- på vad som beställdes och av vem. Att kunna radera hantverkaren ur registret
-- och lämna ordern utan mottagare hade gjort beviset obegripligt. Raderingen
-- (GDPR) måste därför ta ställning till ordrarna först.

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('SENT', 'ACCEPTED', 'DECLINED', 'CANCELLED');


-- CreateTable
CREATE TABLE "ContractorWorkOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'SENT',
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "sentToEmail" TEXT NOT NULL,
    "sharedTenantContact" TEXT,
    "responseTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "proposedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractorWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractorWorkOrder_responseTokenHash_key" ON "ContractorWorkOrder"("responseTokenHash");

-- CreateIndex
CREATE INDEX "ContractorWorkOrder_organizationId_idx" ON "ContractorWorkOrder"("organizationId");

-- CreateIndex
CREATE INDEX "ContractorWorkOrder_ticketId_idx" ON "ContractorWorkOrder"("ticketId");

-- CreateIndex
CREATE INDEX "ContractorWorkOrder_contractorId_idx" ON "ContractorWorkOrder"("contractorId");

-- CreateIndex
CREATE INDEX "ContractorWorkOrder_responseTokenHash_idx" ON "ContractorWorkOrder"("responseTokenHash");

-- AddForeignKey
ALTER TABLE "ContractorWorkOrder" ADD CONSTRAINT "ContractorWorkOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorWorkOrder" ADD CONSTRAINT "ContractorWorkOrder_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "MaintenanceTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorWorkOrder" ADD CONSTRAINT "ContractorWorkOrder_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorWorkOrder" ADD CONSTRAINT "ContractorWorkOrder_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

