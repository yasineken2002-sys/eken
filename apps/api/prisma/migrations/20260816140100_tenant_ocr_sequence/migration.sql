-- H1, steg 2 av 2: en OCR-räknare per organisation.
--
-- Körs EFTER att den globala unikheten lossats (steg 1), aldrig före: sekvensen
-- delar ut nummer som två organisationer får dela, och det är bara tillåtet
-- under den org-scopade begränsningen.
CREATE TABLE "TenantOcrSequence" (
    "organizationId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantOcrSequence_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "TenantOcrSequence"
    ADD CONSTRAINT "TenantOcrSequence_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL: seeda med ANTALET hyresgäster som redan har ett OCR i organisationen.
--
-- Det speglar exakt den gamla `count()+1`-semantiken, så nästa allokering
-- fortsätter där den gamla mekanismen slutade i stället för att börja om på en
-- position som redan delats ut. Befintliga OCR-nummer ändras ALDRIG — de sitter
-- på avier och i hyresgästernas autogiron, och ett OCR som byts är en betalning
-- som inte matchar.
--
-- (Formen på de gamla numren skiljer sig dessutom från de nya: gamla bär ett
-- org-prefix, nya är rena löpnummer. Seedningen skyddar mot positionsåteranvändning,
-- inte mot formkollision — den senare kan inte uppstå.)
INSERT INTO "TenantOcrSequence" ("organizationId", "lastNumber", "updatedAt")
SELECT "organizationId", COUNT(*), NOW()
FROM "Tenant"
WHERE "ocrNumber" IS NOT NULL
GROUP BY "organizationId";
