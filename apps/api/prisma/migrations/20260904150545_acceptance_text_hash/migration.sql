-- #577 — acceptansraden ska bära VILKEN TEXT, inte bara vilket nummer.
--
-- `termsVersion` säger vilket nummer kunden godkände. En redaktionell ändring
-- är tillåten utan versionsbump, och då betecknar samma nummer två olika
-- texter. Hashen finns redan i LEGAL_DOCUMENT_HASHES; den skrevs bara aldrig
-- in i raden. Integritetspolicyn journalfördes inte alls.
--
-- ALLA TRE ÄR NULLBARA UTAN SENTINEL, och det är ett beslut:
-- NULL betyder "accepterad före fältet fanns". Raderna som skrevs före den här
-- migrationen kan inte efterkonstrueras — manifestet bär dagens hash, inte den
-- som gällde vid deras acceptans. En backfill hade skrivit in en text kunden
-- aldrig såg, vilket är sämre än att sakna uppgiften.
--
-- Ingen unik kolumnmängd rör fälten, så CLAUDE.md:s regel om NOT NULL med
-- sentinel gäller inte: två NULL kan inte kollidera här.

ALTER TABLE "Organization" ADD COLUMN "termsHash" TEXT;
ALTER TABLE "Organization" ADD COLUMN "privacyVersion" TEXT;
ALTER TABLE "Organization" ADD COLUMN "privacyHash" TEXT;

ALTER TABLE "User" ADD COLUMN "termsHash" TEXT;
ALTER TABLE "User" ADD COLUMN "privacyVersion" TEXT;
ALTER TABLE "User" ADD COLUMN "privacyHash" TEXT;
