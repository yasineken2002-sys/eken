-- HANTVERKARENS SVAR OCH AVBOKNINGEN ÄR TVÅ OLIKA FRÅGOR
--
-- `status` är orderns NUVARANDE tillstånd. Det räckte tills avbokningen fanns:
-- en ACCEPTERAD order som avbokas får `status = CANCELLED`, och historiken —
-- som gatade händelsen på status — tappade då att hantverkaren någonsin tog
-- jobbet. En historik som skrivs om i efterhand.
--
-- Uppmätt som en RÖD assertion (prov 12 i work-order.db.spec.ts) innan fälten
-- fanns, inte resonerad fram.
--
--   responseAccepted  vad hantverkaren SVARADE      (hantverkarens handling)
--   cancelledAt       när ordern ströks             (hyresvärdens handling)
--
-- Båda nullbara: NULL betyder "har inte hänt", vilket är sant för varje rad som
-- fanns före kolumnerna. Ingen backfill — och det finns ingenting att backfilla,
-- eftersom föregående migration i samma PR skapade tabellen.

-- AlterTable
ALTER TABLE "ContractorWorkOrder" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "responseAccepted" BOOLEAN;
