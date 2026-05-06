-- Stöd för svenska företagsformer + F-skatt på faktura.
--
-- companyForm styr orgnummer-validering, BAS-kontoplan (eget kapital-serie)
-- och kontraktsformuleringar (firmatecknare/ägare/bolagsman). Default AB
-- för befintliga organisationer — historiskt antagande i Eken-databasen.
--
-- hasFSkatt + fSkattApprovedDate används för att skriva ut "Godkänd för
-- F-skatt" på fakturor enligt 11 kap. 8 § ML.

-- CreateEnum
CREATE TYPE "CompanyForm" AS ENUM ('AB', 'ENSKILD_FIRMA', 'HB', 'KB', 'FORENING', 'STIFTELSE');

-- AlterTable
ALTER TABLE "Organization"
  ADD COLUMN "companyForm" "CompanyForm" NOT NULL DEFAULT 'AB',
  ADD COLUMN "hasFSkatt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fSkattApprovedDate" TIMESTAMP(3);
