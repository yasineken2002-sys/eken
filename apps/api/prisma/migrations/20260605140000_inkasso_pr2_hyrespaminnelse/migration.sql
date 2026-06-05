-- Inkasso · PR 2 — hyrespåminnelse (dag 7, konfigurerbar momsfri avgift).
--
-- Lägger grunden för att en förfallen hyresavi ska kunna eskaleras till REMINDED
-- med en påminnelseavgift som bokförs 1510 D / 3593 K (momsfri).
--
--   • JournalEntrySource += RENT_NOTICE — egen idempotensserie för avins
--     verifikat (sourceId='reminder-fee:{id}'), skild från faktura-flödets
--     INVOICE-serie. ADD VALUE används INTE i denna migration (ingen data
--     skrivs med värdet här) → ingen "unsafe use of new value"-risk.
--   • RentNotice.reminderFeeAmount — påminnelseavgiften på avin. Default 0 →
--     noll påverkan på befintliga/icke-påminda avier. Ingår i den betalbara
--     totalen (rentNoticePayableTotal) så fordran på 1510 och avins OCR-belopp
--     hålls konsistenta; bankavstämningen matchar mot samma summa.

ALTER TYPE "JournalEntrySource" ADD VALUE 'RENT_NOTICE';

ALTER TABLE "RentNotice" ADD COLUMN     "reminderFeeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
