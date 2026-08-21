-- H1: gör unikheten på Invoice.ocrNumber till en INVARIANT i stället för en vana.
--
-- ── VAD SOM FAKTISKT SAKNADES ────────────────────────────────────────────────
--
-- Tilldelningen var redan atomisk: `Invoice.ocrNumber = pad7(sekvens) + Luhn`
-- där sekvensen kommer från `InvoiceNumberSequence` via en increment-UPSERT i
-- samma transaktion som fakturan skapas (invoices/invoice-number.ts). Racet var
-- alltså aldrig öppet här.
--
-- Men unikheten VILADE HELT på att den härledningen är injektiv. I databasen
-- fanns bara `@@index([ocrNumber])` — ett vanligt index, ingen begränsning. Ett
-- OCR som skrivs från något annat håll, eller en ändrad paddning som får två
-- sekvensnummer att avbildas på samma sträng, hade sparats utan invändning. Vad
-- det ger: `matchTransaction` (reconciliation.service.ts:806-812) slår upp
-- (organizationId, ocrNumber) och tar `findFirst` — betalningen landar på den
-- rad Postgres råkar returnera först. Fel faktura betalas, ingenting larmar.
--
-- ── MÄTT FÖRE ÄNDRINGEN ──────────────────────────────────────────────────────
--
-- Prod, 2026-08-21: noll dubbletter inom en org, noll OCR delade över orgar,
-- noll korsträffar mot Tenant.ocrNumber. Nämnaren är dock liten (2 orgar,
-- 0 fakturor med OCR) — mätningen utesluter en pågående incident, den bevisar
-- inte att härledningen håller vid skala. Det är precis därför invarianten
-- flyttas ned i databasen i stället för att lämnas som en egenskap hos koden.
--
-- ── DEN HÄR MIGRATIONEN FÅR FALLA ────────────────────────────────────────────
--
-- Till skillnad från steg 1 i Tenant-migrationen (20260816140000) LOSSAR den här
-- inte en begränsning — den lägger på en. Finns dubbletter i någon miljö faller
-- `prisma migrate deploy` här, och det är det avsedda utfallet: en dubblett är en
-- betalning som kan hamna fel, och den ska utredas innan den begravs under ett
-- index. Åtgärden är då att identifiera raderna
--
--   SELECT "organizationId", "ocrNumber", count(*) FROM "Invoice"
--   WHERE "ocrNumber" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
--
-- och avgöra vilken faktura som ska behålla numret — aldrig att skriva om ett
-- OCR som redan finns hos en hyresgäst eller på ett autogiro.
--
-- NULL räknas som distinkt i Postgres unika index. Kreditnotor (ocrNumber = null,
-- credit-note.service.ts:384) och depositionsfakturor (får aldrig något OCR,
-- deposits.service.ts) är därför opåverkade — flera NULL per org är tillåtet.

DROP INDEX "Invoice_ocrNumber_idx";

CREATE UNIQUE INDEX "Invoice_organizationId_ocrNumber_key"
    ON "Invoice"("organizationId", "ocrNumber");
