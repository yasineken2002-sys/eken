-- Gruppering av per-mottagarrader till ETT utskick i operatörens vy.
--
-- #633 gjorde enheten i DATAN till mottagaren — enda sättet att svara på "fick
-- DEN HÄR hyresgästen sitt brev?" efter en krasch mitt i en loop. Följden var
-- att ett massutskick till 40 hyresgäster blev 40 rader i meddelandelistan där
-- det tidigare stod en. Det är en försämring av en vy som fungerade.
--
-- Enheten i VYN är utskicket. `batchId` ger båda utan att välja: vyn grupperar
-- på det när det finns och visar enskilda rader när det inte gör det.
--
-- ADDITIVT OCH NULLBART, INGEN BACKFILL. Befintliga rader får NULL, vilket är
-- det ärliga läget — de vet inte vilket utskick de tillhörde, och en gissad
-- gruppering hade varit sämre än ingen. De renderas som enskilda rader, vilket
-- är exakt vad de är.
ALTER TABLE "SentMessage" ADD COLUMN "batchId" TEXT;

-- Vyn frågar "alla rader i den här gruppen, inom min organisation".
CREATE INDEX "SentMessage_organizationId_batchId_idx" ON "SentMessage"("organizationId", "batchId");
