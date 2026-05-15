-- DB-nivå dubblettskydd för PLAN_FEE-fakturor.
--
-- Idempotensen i createMonthlyInvoices/generateInvoicesForPeriod är app-nivå
-- (findFirst innan create) och skyddar inte mot races: manuell trigger som
-- krockar med schemalagd cron, eller flera API-instanser. Detta partiella
-- unika index garanterar att en organisation aldrig kan få två fakturor för
-- samma period — men bara när planPeriodStart är satt (dvs PLAN_FEE).
-- AI_CREDITS och OTHER (planPeriodStart = NULL) lämnas obegränsade.
--
-- Prisma stödjer inte partiella unika index i schema.prisma, därför rå SQL.
-- Koden fångar Prisma P2002 och behandlar krocken som "skipped".

CREATE UNIQUE INDEX "platform_invoice_unique_period"
  ON "PlatformInvoice" ("organizationId", "type", "planPeriodStart")
  WHERE "planPeriodStart" IS NOT NULL;
