-- En enda sats: CONCURRENTLY får inte kombineras med SET/annan DDL i samma fil.
-- Kvarvarande detaljer läses i samma C-ordning som nycklarna i checkpointkärnan.
-- Befintlig unik identitet (runId, key) och organisationsbundna FK behålls.
CREATE INDEX CONCURRENTLY "fortnox_read_pending_key_c"
ON "FortnoxReadVoucherCheckpoint" ("organizationId", "runId", "key" COLLATE "C")
WHERE "detailDigest" IS NULL;
