-- RÄTTELSE AV ETT SLUTFÖRT PROTOKOLL: EN NY VERSION, INTE EN ÖVERSKRIVNING
--
-- 20260917100000_inspection_signature_lock frös det signerade protokollet, och
-- det var rätt. Men frysningen lämnade en fråga obesvarad: vad gör förvaltaren
-- när protokollet är FEL? Fram till den här migrationen fanns två utvägar, och
-- båda är dåliga — låta felet stå, eller radera hela beviset.
--
-- Kolumnerna nedan gör en TREDJE väg möjlig: en länkad rättelseversion som är
-- ett eget protokoll, med egen livscykel och egna spärrar, medan originalet
-- ligger kvar orört med sina poster, sina bilder och sin signatur.
--
-- ── `correctionOfId` ÄR UNIK, OCH DET ÄR SAMTIDIGHETSGARANTIN ───────────────
--
-- En version kan ha HÖGST EN rättelse. Det unika villkoret är inte en
-- datamodellsåsikt utan den enda konstruktion som håller när två förvaltare
-- rättar samma version i samma sekund: en läs-sedan-skriv-kontroll i
-- tjänstelagret kan två transaktioner passera i tur och ordning och båda få ja.
-- Databasen kan bara ge ett ja.
--
-- ── `NO ACTION`, INTE `RESTRICT` ────────────────────────────────────────────
--
-- Båda hindrar att en version med rättelse raderas styckvis. Skillnaden är NÄR
-- villkoret prövas: `RESTRICT` prövar omedelbart och hade fällt även
-- organisationens kaskadradering, där både förälder och barn försvinner i samma
-- sats. `NO ACTION` prövar vid satsens slut och släpper igenom just det fallet.
--
-- ── BEFINTLIGA RADER ────────────────────────────────────────────────────────
--
-- `version` får DEFAULT 1: varje protokoll som finns i dag ÄR sin kedjas
-- original, och det är ett påstående om form, inte om innehåll — till skillnad
-- från en digest eller en tidsstämpel kan det inte bli fel i efterhand.
--
-- De fyra övriga är nullbara utan default. NULL betyder "inte en rättelse",
-- vilket är sant för varje befintlig rad. Ingenting backfillas.

BEGIN;

ALTER TABLE "Inspection" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Inspection" ADD COLUMN "correctionOfId" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "correctionReason" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "correctedById" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "correctedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Inspection_correctionOfId_key" ON "Inspection"("correctionOfId");

ALTER TABLE "Inspection"
  ADD CONSTRAINT "Inspection_correctionOfId_fkey"
  FOREIGN KEY ("correctionOfId") REFERENCES "Inspection"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
