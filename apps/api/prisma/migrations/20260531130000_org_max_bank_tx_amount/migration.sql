-- Per-org konfigurerbar beloppsrimlighetsgräns för PDF-bankavstämning (#36).
-- Intern kontrollgräns (COSO), inte lagkrav. Default 5 MSEK; backfillar ALLA
-- befintliga orgs till 5 MSEK (sänker från de-facto 50 MSEK enligt issuens
-- intent). Rader över gränsen flaggas/avvisas + loggas — ingen hård import-stopp.
ALTER TABLE "Organization" ADD COLUMN "maxBankTxAmount" DECIMAL(14,2) NOT NULL DEFAULT 5000000;
