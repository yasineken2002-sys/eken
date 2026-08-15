-- #473: arkivpekare till det uppladdade originalet.
-- Additiv och nullable — befintliga rader har inget arkiverat original
-- (filen raderades vid SCANNED innan den här ändringen), och det går inte
-- att återskapa i efterhand. NULL betyder därför "original saknas", vilket
-- är sant för allt som importerats före den här migrationen.
ALTER TABLE "ContractImportRow" ADD COLUMN "documentId" TEXT;
