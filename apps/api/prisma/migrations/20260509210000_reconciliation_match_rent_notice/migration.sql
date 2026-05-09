-- Bug 3: BankTransaction matchade tidigare bara mot Invoice, aldrig mot
-- RentNotice (hyresavi). Konsekvens: alla hyresinbetalningar via BgMax
-- landade som UNMATCHED och krävde manuell matchning.
--
-- Den här migrationen lägger till matchedRentNoticeId och en CHECK-constraint
-- som garanterar XOR mellan invoiceId och matchedRentNoticeId. Att låta DB
-- vakta invarianten skyddar mot framtida buggar i service-lagret som annars
-- skulle kunna lämna en transaktion länkad till båda samtidigt.

ALTER TABLE "BankTransaction"
  ADD COLUMN "matchedRentNoticeId" TEXT;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_matchedRentNoticeId_fkey"
  FOREIGN KEY ("matchedRentNoticeId") REFERENCES "RentNotice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BankTransaction_matchedRentNoticeId_idx"
  ON "BankTransaction" ("matchedRentNoticeId");

-- XOR-invariant: max ETT av match-fälten får vara satt. NULL för båda är
-- giltigt (UNMATCHED). Constraint-namnet följer BankTransaction-prefix
-- så Prisma-introspektion inte föreslår att ta bort det.
ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_match_xor"
  CHECK (
    "invoiceId" IS NULL
    OR "matchedRentNoticeId" IS NULL
  );
