-- Personnummer krypterat i vila på Tenant och Customer.
--
-- EXPAND-fasen. Migrationen är AVSIKTLIGT icke-destruktiv: den lägger bara till
-- de två nya kolumnerna och blind-index-indexen. Klartext-kolumnen
-- "personalNumber" ligger kvar och rörs inte här.
--
-- VARFÖR INTE KRYPTERA HÄR: krypteringen är AES-256-GCM med nyckel ur env
-- (SIGNING_PII_KEY). Postgres har ingen GCM i pgcrypto, och att skicka in
-- nyckeln i SQL skulle lägga den i migrationsfilen och i serverloggen. Själva
-- omvandlingen görs därför av backfill-skriptet
-- (src/scripts/backfill-personal-numbers.ts), som körs av migrate-and-start.sh
-- direkt efter `prisma migrate deploy` och före appstart.
--
-- CONTRACT-fasen (DROP COLUMN "personalNumber") ligger i en uppföljande PR och
-- körs först när backfillen är bekräftad klar i produktion. Att droppa i samma
-- migration hade raderat klartexten innan något hunnit kryptera den.
--
-- Handskriven med flit: `prisma migrate diff` drar in orelaterad dev-drift
-- (senast en DROP INDEX på ett skarpt HNSW-vektorindex).

ALTER TABLE "Tenant" ADD COLUMN "personalNumberEnc" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "personalNumberHash" TEXT;

ALTER TABLE "Customer" ADD COLUMN "personalNumberEnc" TEXT;
ALTER TABLE "Customer" ADD COLUMN "personalNumberHash" TEXT;

-- Uppslag på blind-index sker alltid inom en organisation (multi-tenant-scoping),
-- därför sammansatt index med organizationId först.
CREATE INDEX "Tenant_organizationId_personalNumberHash_idx" ON "Tenant"("organizationId", "personalNumberHash");
CREATE INDEX "Customer_organizationId_personalNumberHash_idx" ON "Customer"("organizationId", "personalNumberHash");
