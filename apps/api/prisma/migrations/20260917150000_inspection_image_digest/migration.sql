-- BILAGANS INNEHÅLL BINDS TILL SIGNATUREN (F025, uppföljning)
--
-- Signaturunderlaget band bilderna via `storageKey`, `filename`, `caption`,
-- `room` och `size`. Ingen av dem beskriver objektets INNEHÅLL: en `PutObject`
-- mot samma nyckel byter bytes utan att något av fälten ändras, och `size`
-- fångar bara ett byte som råkar ändra längden.
--
-- `contentSha256` är en digest av de bytes servern faktiskt tog emot, beräknad
-- vid uppladdningen ur samma buffer som skrevs till lagringen.
--
-- ── ÄLDRE RADER FÅR NULL, OCH BACKFILLAS INTE ───────────────────────────────
--
-- En digest beräknad i dag beskriver objektet i dag, inte vid uppladdningen.
-- Att skriva in den som om den gällde då hade varit en retroaktiv bildattest
-- utan täckning — exakt det som "signedContentHash" avstod från i
-- 20260917100000_inspection_signature_lock. NULL betyder OKÄNT, och
-- underlaget bär NULL vidare i klartext i stället för att utelämna fältet.
--
-- Kolumnen är nullbar och utan default: inget befintligt objekt rörs.

BEGIN;

ALTER TABLE "InspectionImage" ADD COLUMN "contentSha256" TEXT;

COMMIT;
