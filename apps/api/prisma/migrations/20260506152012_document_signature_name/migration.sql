-- Hyresgästens skrivna namnunderskrift vid signering.
-- Lagras separat från signedByTenant så att vi har två oberoende
-- identitetsspår: vem som autentiserade (FK) och vad de själva skrev.
ALTER TABLE "Document" ADD COLUMN "signatureName" TEXT;
