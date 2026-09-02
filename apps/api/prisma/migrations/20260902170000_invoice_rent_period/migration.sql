-- EN HYRESFAKTURA PER AVTAL OCH PERIOD — DB-enforcerat.
--
-- Dubbelfaktureringsspärren i InvoicesService var en LÄSNING FÖRE en skrivning,
-- eftersom perioden bars av två tabeller: RentNotice har den som month/year,
-- Invoice bara som ett härlett värde ur issueDate. Två samtidiga create_invoice
-- för samma avtal och period kunde därför båda passera.
--
-- Kolumnerna nedan gör Invoice-halvan uttryckbar som ett villkor. Avi-halvan
-- spänner fortfarande två tabeller och blir kvar som en läsning — se den kända
-- gränsen i invoices.service.ts.
--
-- ── VARFÖR INTE GENERATED ALWAYS AS ─────────────────────────────────────────
--
-- Den formen fungerar i Postgres (prövat) men kan bara härleda ur det LAGRADE
-- värdet, och issueDate är en DATE: tidszonen är redan borta. Uppslaget mot
-- RentNotice använder svensk civil tid, och för en tidsstämpel mellan 22:00 UTC
-- och midnatt ger de två härledningarna olika månad. En genererad kolumn hade
-- alltså infört en andra definition av "period" — två sanningar i stället för
-- en drift. Kolumnerna skrivs ur samma stockholmCivilDate som uppslaget.
ALTER TABLE "Invoice" ADD COLUMN "rentPeriodYear" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "rentPeriodMonth" INTEGER;

-- Backfill för befintliga hyresfakturor. Mätt före migrationen: prod 0 fakturor,
-- dev 0 — satsen är alltså tom i dag, och står här för miljöer som inte är det.
-- issueDate är en DATE, så EXTRACT ger samma månad som den civila för alla rader
-- som skrevs från ett datum utan klockslag (vilket är allt som finns).
UPDATE "Invoice"
   SET "rentPeriodYear"  = EXTRACT(YEAR  FROM "issueDate")::int,
       "rentPeriodMonth" = EXTRACT(MONTH FROM "issueDate")::int
 WHERE type = 'RENT';

-- ── PREDIKATET ÄR KONSTRUKTIONEN ───────────────────────────────────────────
--
-- type = 'RENT'
--   Bara hyra har en period. En serviceavgift eller en deposition för samma
--   avtal och månad är en annan sak och ska aldrig krocka.
--
-- "creditedInvoiceId" IS NULL
--   ⚠️ LÄS DEN HÄR INNAN DU FÖRENKLAR VILLKORET. credit-note.service skriver
--   `type: original.type`, så en kreditnota på en hyresfaktura är SJÄLV
--   type = 'RENT', med samma leaseId och issueDate = idag. Utan det här ledet
--   krockar fakturan med sin egen kreditnota i samma månad — och att kreditera
--   i samma månad är det NORMALA fallet, inte undantaget.
--
-- status <> 'VOID'
--   En makulerad faktura gör inte längre anspråk på perioden. En ersättare för
--   samma månad är då en legitim andra handling.
CREATE UNIQUE INDEX "invoice_rent_period_unique"
  ON "Invoice" ("leaseId", "rentPeriodYear", "rentPeriodMonth")
  WHERE type = 'RENT' AND "creditedInvoiceId" IS NULL AND status <> 'VOID';
