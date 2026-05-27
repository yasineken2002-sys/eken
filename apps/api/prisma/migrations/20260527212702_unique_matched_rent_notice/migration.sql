-- Belt-and-suspenders mot dubbel-match av samma hyresavi.
--
-- Bakgrund: OCR är per hyresgäst (samma OCR delas över ALLA månads-avier
-- för tenant X). Innan denna fix kunde två parallella bank-importer båda
-- länka samma BankTransaction till samma RentNotice via en TOCTOU-race i
-- applyMatchToRentNotice. Den status-guardade updateMany i koden är den
-- primära skydd; @unique här är DB-nivå-baksäte så att felaktig kod aldrig
-- kan korrumpera betalningshistoriken.
--
-- DropIndex: byt det icke-unika indexet mot ett unique-index. Postgres
-- använder ändå unique-indexet för planern (b-tree-lookup på lika villkor).

-- DropIndex
DROP INDEX "BankTransaction_matchedRentNoticeId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_matchedRentNoticeId_key" ON "BankTransaction"("matchedRentNoticeId");
