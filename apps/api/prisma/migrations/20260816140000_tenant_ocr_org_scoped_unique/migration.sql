-- H1, steg 1 av 2: byt Tenant.ocrNumber från GLOBALT unikt till unikt PER ORG.
--
-- Ordningen är medveten: att LOSSA en begränsning är säkert i sig, och den här
-- migrationen delar inte ut några nya nummer. Sekvensen (steg 2) får aldrig
-- börja allokera under den gamla, hårdare begränsningen.
--
-- Varför globalt inte behövdes: varje OCR-uppslag i matchningen bär
-- organizationId (reconciliation.service.ts:798-801 och :839-842), eftersom
-- betalningen landar på organisationens eget bankgiro och filen/PSD2-samtycket
-- därför alltid tillhör en känd org.
--
-- Den nya begränsningen är SVAGARE än den gamla, så varje befintlig rad
-- uppfyller den redan — ingen data behöver röras och migrationen kan inte falla
-- på existerande innehåll.
--
-- OBS: Postgres räknar NULL som distinkt i unika index, så flera hyresgäster
-- utan OCR inom samma org är fortsatt tillåtet — precis som förut.
DROP INDEX "Tenant_ocrNumber_key";

CREATE UNIQUE INDEX "Tenant_organizationId_ocrNumber_key"
    ON "Tenant"("organizationId", "ocrNumber");
