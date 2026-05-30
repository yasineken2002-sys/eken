-- FIX 9 · PR 3 — Frivillig skattskyldighet per lokal (LAGBROTT 5, ML 1994:200)
--
-- Lägger till Unit.voluntaryTaxLiability. Styr om en lokal (OFFICE/RETAIL/
-- STORAGE/OTHER) ska beläggas med 25% moms enligt frivillig skattskyldighet
-- (ML 9 kap, 3 kap 3 § 2 st). Default false → momsfri, vilket är korrekt
-- huvudregel (ML 3 kap 2 §). Bostäder (APARTMENT) är alltid momsfria oavsett
-- detta fält; parkering är momspliktig enligt lag oberoende av fältet.
ALTER TABLE "Unit" ADD COLUMN "voluntaryTaxLiability" BOOLEAN NOT NULL DEFAULT false;
