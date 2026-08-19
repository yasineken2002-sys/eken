-- #517 (den obetalda halvan): kreditnota på Invoice.
--
-- ADDITIV. Inget befintligt värde ändras: båda kolumnerna är nya, den ena med
-- DEFAULT false och den andra nullbar. Befintliga fakturor blir `isCreditNote =
-- false, creditedInvoiceId = NULL` — vilket är exakt vad de är.
--
-- INGEN NY SEKVENSTABELL. Kreditnotan drar nummer ur samma
-- InvoiceNumberSequence som vanliga fakturor. Serien är redan en obruten,
-- org-scopad sekvens med atomär allokering; en egen kreditserie hade dessutom
-- krävt ett `series`-fält som InvoiceNumberSequence inte har (jfr
-- JournalEntrySequence, som har det). Det avgörande för spårbarheten är inte
-- vilken serie numret kommer ur, utan att kreditnotan entydigt pekar ut
-- originalet — vilket den främmande nyckeln nedan gör.

ALTER TABLE "Invoice" ADD COLUMN "isCreditNote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "creditedInvoiceId" TEXT;

-- Uppslagning original → kreditnotor. computeInvoiceDebt går den vägen varje
-- gång en fakturas restskuld beräknas, alltså i påminnelse-, inkasso- och
-- portalvägarna.
CREATE INDEX "Invoice_creditedInvoiceId_idx" ON "Invoice"("creditedInvoiceId");

-- Självrelation. RESTRICT av samma skäl som Invoice→Organization: krediteringen
-- är räkenskapsinformation (BFL 7 år) och originalet får inte kunna raderas
-- under den.
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_creditedInvoiceId_fkey"
  FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── VAKTEN I DATABASEN ──────────────────────────────────────────────────────
--
-- En kreditnota UTAN koppling till sitt original är ett dokument som krediterar
-- ingenting: beloppet försvinner ur skuldberäkningen utan att gå att härleda
-- till vad som krediterades. Applikationslagret (CreditNoteService) är enda
-- vägen in i dag, men en CHECK gäller ÄVEN för ett framtida skript, en
-- datamigrering eller en ny kodväg som skriver förbi tjänsten.
--
-- Samma mönster och samma motivering som Invoice_tenant_xor_customer_chk och
-- AccountingPeriodEvent-ens CHECK på `reason`.
--
-- Notera riktningen: constraint:en säger ingenting om vanliga fakturor. Bara
-- `isCreditNote = true` kräver ett original.
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_credit_note_requires_original_chk"
  CHECK (NOT "isCreditNote" OR "creditedInvoiceId" IS NOT NULL);
