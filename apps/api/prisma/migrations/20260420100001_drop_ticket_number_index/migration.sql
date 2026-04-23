-- Drop the old global unique index on ticketNumber (replaced by composite unique on organizationId+ticketNumber)
DROP INDEX IF EXISTS "MaintenanceTicket_ticketNumber_key";
