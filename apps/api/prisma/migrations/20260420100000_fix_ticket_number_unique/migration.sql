-- Drop the global unique constraint on ticketNumber
ALTER TABLE "MaintenanceTicket" DROP CONSTRAINT IF EXISTS "MaintenanceTicket_ticketNumber_key";

-- Add composite unique constraint scoped to organization
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_organizationId_ticketNumber_key" UNIQUE ("organizationId", "ticketNumber");
