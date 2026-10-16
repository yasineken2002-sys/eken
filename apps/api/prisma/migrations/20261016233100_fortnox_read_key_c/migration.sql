-- En enda sats: CONCURRENTLY får inte kombineras med SET/annan DDL i samma fil.
-- Sidvis återläsning behöver C-ordning även när alla detaljer är färdiga.
-- Inga JSON-underlag dupliceras i indexet; befintlig unik identitet behålls.
CREATE INDEX CONCURRENTLY "fortnox_read_key_c"
ON "FortnoxReadVoucherCheckpoint" ("organizationId", "runId", "key" COLLATE "C");
