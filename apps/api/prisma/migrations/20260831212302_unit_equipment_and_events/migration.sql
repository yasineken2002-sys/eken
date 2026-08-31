-- CreateEnum
CREATE TYPE "UnitEquipmentKind" AS ENUM ('REFRIGERATOR', 'FREEZER', 'STOVE', 'DISHWASHER', 'WASHING_MACHINE', 'DRYER', 'BOILER', 'HEAT_PUMP', 'VENTILATION', 'ELEVATOR', 'BATHROOM_FIXTURE', 'KITCHEN_FIXTURE', 'FLOORING', 'WINDOW', 'DOOR', 'LOCK', 'OTHER');

-- CreateEnum
CREATE TYPE "UnitEquipmentEventType" AS ENUM ('INSTALLED', 'SERVICED', 'REPAIRED', 'REPLACED', 'REMOVED');

-- DropIndex
DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "UnitEquipment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT,
    "kind" "UnitEquipmentKind" NOT NULL,
    "label" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitEquipmentEvent" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "type" "UnitEquipmentEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "maintenanceTicketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitEquipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnitEquipment_replacedById_key" ON "UnitEquipment"("replacedById");

-- CreateIndex
CREATE INDEX "UnitEquipment_organizationId_idx" ON "UnitEquipment"("organizationId");

-- CreateIndex
CREATE INDEX "UnitEquipment_propertyId_idx" ON "UnitEquipment"("propertyId");

-- CreateIndex
CREATE INDEX "UnitEquipment_unitId_idx" ON "UnitEquipment"("unitId");

-- CreateIndex
CREATE INDEX "UnitEquipmentEvent_equipmentId_occurredAt_idx" ON "UnitEquipmentEvent"("equipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "UnitEquipmentEvent_maintenanceTicketId_idx" ON "UnitEquipmentEvent"("maintenanceTicketId");

-- AddForeignKey
ALTER TABLE "UnitEquipment" ADD CONSTRAINT "UnitEquipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitEquipment" ADD CONSTRAINT "UnitEquipment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitEquipment" ADD CONSTRAINT "UnitEquipment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitEquipment" ADD CONSTRAINT "UnitEquipment_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "UnitEquipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitEquipmentEvent" ADD CONSTRAINT "UnitEquipmentEvent_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "UnitEquipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitEquipmentEvent" ADD CONSTRAINT "UnitEquipmentEvent_maintenanceTicketId_fkey" FOREIGN KEY ("maintenanceTicketId") REFERENCES "MaintenanceTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── APPEND-ONLY-SPÄRR FÖR UnitEquipmentEvent (#585-mekaniken) ───────────────
--
-- Samma funktion och samma form som de åtta tabellerna i
-- 20260828140000_append_only_event_triggers: BEFORE UPDATE, FOR EACH STATEMENT.
--
-- VARFÖR SATSNIVÅ OCH INTE RADNIVÅ: satsnivå räcker när ingen laglig
-- kaskad-UPDATE kan träffa tabellen. De två tabeller som behövde radnivå i
-- #585 (AccountingPeriodEvent, TenantAnonymizationLog) tog emot
-- `ON DELETE SET NULL` från User — en UPDATE databasen gör utan att koden vet
-- om det. Den här tabellens enda nullbara FK (maintenanceTicketId) är
-- `ON DELETE RESTRICT` just för att undvika den klassen, så ingen
-- kaskad-UPDATE kan nå hit.
--
-- DELETE spärras INTE, av samma skäl som i #585: en full spärr hade brutit
-- organisationsraderingen. Raden faller via Cascade från UnitEquipment, och
-- delete-organization.ts raderar den uttryckligen före MaintenanceTicket.
CREATE TRIGGER append_only_unit_equipment_event
  BEFORE UPDATE ON "UnitEquipmentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
