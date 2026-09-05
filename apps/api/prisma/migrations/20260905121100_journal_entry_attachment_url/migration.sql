-- Underlaget till ett MANUELLT bokfört verifikat (BFL 7 kap: räkenskaps-
-- information bevaras i sju år). Nullable och additiv: befintliga rader rörs
-- inte, och de allra flesta verifikat är automatiska med sitt underlag i den
-- affärshändelse de kommer ur.
ALTER TABLE "JournalEntry" ADD COLUMN "attachmentUrl" TEXT;
