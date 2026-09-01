-- Klass B, steg 1: spara handtaget, dedupa den lokala raden.
--
-- externalHandle: det som gör "skedde detta?" besvarbar efteråt (köns job-id,
-- providerns request-id). Nullbar utan default och utan backfill — befintliga
-- rader HAR inget handtag, och att hitta på ett vore ett påstående ingen mätt.
-- NULL skiljer dessutom "påbörjad, inget handtag" från "påbörjad, handtag finns".
ALTER TABLE "AiToolExecution" ADD COLUMN "externalHandle" TEXT;

-- En lokal rad per R2-objekt. En PUT på samma nyckel skriver över, så två rader
-- mot samma nyckel betydde att den ena pekade på innehåll som inte längre fanns.
--
-- SÄKERT ATT APPLICERA, mätt före migrationen: noll grupper med samma
-- (organizationId, storageKey) i både dev och prod (1 Document i vardera).
CREATE UNIQUE INDEX "Document_organizationId_storageKey_key" ON "Document"("organizationId", "storageKey");
