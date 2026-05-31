-- BFL 5 kap 11 § (behandlingshistorik) + 7 kap 2 § (räkenskapsinformation).
-- Bevara AI:ns råtolkning (originalParsedData, immutabel) och den faktiskt
-- commitade listan (confirmedData, immutabel) separat från den redigerbara
-- preview-listan (parsedData). Alla nullable → bakåtkompatibelt för
-- befintliga rader; ingen backfill (historiska rader saknar bevarad råtolkning).
ALTER TABLE "BankStatementImport" ADD COLUMN "originalParsedData" JSONB;
ALTER TABLE "BankStatementImport" ADD COLUMN "confirmedData" JSONB;
