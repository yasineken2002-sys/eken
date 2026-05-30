-- Lease.contractNumber: globalt unik → unik PER ORGANISATION
--
-- Bugg (P2002): contractNumber hade ett globalt unikt index
-- (Lease_contractNumber_key) medan kontraktsnumren genereras från
-- ContractNumberSequence som räknar PER organisation och år. Två olika
-- organisationer som aktiverar sitt första kontrakt 2026 får därför båda
-- numret KONT-2026-00001 — det andra försöket kraschade mot det globala
-- indexet med P2002 vid DRAFT → ACTIVE-aktivering.
--
-- Fixen gör numret unikt inom organisationen (matchar verifikationsnummer-
-- och fakturanummer-mönstret). Detta SLÄPPER på constrainten (per-org är
-- svagare än globalt), så befintliga rader — som redan är globalt unika —
-- förblir giltiga. NULL (DRAFT-kontrakt utan nummer) räknas inte som
-- dubblett i Postgres, så flera DRAFT per org är fortsatt tillåtet.

-- DropIndex (globalt unikt)
DROP INDEX "Lease_contractNumber_key";

-- CreateIndex (unikt per organisation)
CREATE UNIQUE INDEX "Lease_organizationId_contractNumber_key" ON "Lease"("organizationId", "contractNumber");
