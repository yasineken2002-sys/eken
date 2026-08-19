-- #517 uppföljning: radnivå-taket behöver veta VILKEN rad som krediteras.
--
-- ADDITIV. En ny nullbar kolumn; varje befintlig rad blir NULL, vilket är exakt
-- vad de är — vanliga fakturarader krediterar ingenting.
--
-- EGEN MIGRATION, inte en ändring av 20260819220000. Den är redan applicerad i
-- utvecklingsdatabasen, och Prisma lagrar en checksumma per applicerad
-- migration — att redigera den i efterhand får `migrate deploy` att vägra med
-- "migration modified after applied".
--
-- VARFÖR KOLUMNEN BEHÖVS. Taket "en kreditnotarad får inte överstiga
-- motsvarande rad på ursprungsfakturan" måste hålla KUMULATIVT. Utan
-- kopplingen kan samma 1 000-kronorsrad krediteras med 1 000 kr i två separata
-- kreditnotor — var för sig inom taket, tillsammans dubbelt så mycket som
-- raden var på, och spårbarheten tillbaka till vad som fakturerades är borta
-- igen. Kontrollen summerar därför vad som redan krediterats mot just den
-- raden, vilket kräver att kopplingen är lagrad.

ALTER TABLE "InvoiceLine" ADD COLUMN "creditedInvoiceLineId" TEXT;

CREATE INDEX "InvoiceLine_creditedInvoiceLineId_idx" ON "InvoiceLine"("creditedInvoiceLineId");

-- RESTRICT: originalraden får inte raderas under en kreditering som hänvisar
-- till den. (Raden faller ändå med sin faktura via Invoice→InvoiceLine Cascade;
-- det som spärras här är att EN rad plockas bort under en kreditnota.)
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_creditedInvoiceLineId_fkey"
  FOREIGN KEY ("creditedInvoiceLineId") REFERENCES "InvoiceLine"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
