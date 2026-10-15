-- Tabellen införs tom i föregående migration i samma release. Ingen historisk
-- rad eller bankidentitet backfylls med ett antagande.
ALTER TABLE "CustomerCredit" ADD COLUMN "sourceProofHash" TEXT NOT NULL;
