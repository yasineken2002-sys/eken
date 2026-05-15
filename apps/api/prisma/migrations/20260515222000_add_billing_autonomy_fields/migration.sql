-- Autonom plattformsfakturering: stödfält för auto-send, trial-konvertering
-- och faktureringsspärr.
--
-- PlatformInvoice.lastSendError  – senaste send()-felet, nollställs vid lyckat
--   utskick. Gör att fakturor som skapats men inte mailats kan felsökas.
-- Organization.lastTrialReminderDays – idempotensnyckel för trial-påminnelser
--   (7/3/1 dagar) så samma steg inte mailas dubbelt.
-- Organization.excludeFromBilling – hård spärr mot plattformsfakturering för
--   test-/intern-/friends&family-konton. Respekteras i alla genereringsvägar.

ALTER TABLE "PlatformInvoice"
  ADD COLUMN "lastSendError" TEXT;

ALTER TABLE "Organization"
  ADD COLUMN "lastTrialReminderDays" INTEGER,
  ADD COLUMN "excludeFromBilling" BOOLEAN NOT NULL DEFAULT false;
