-- Lägg till templateInputHash på Document så ContractTemplateService kan
-- dedupa kontrakts-PDF:er när admin upprepat klickar "Generera" utan att
-- något har ändrats. Skild från contentHash som hashar PDF-bytena
-- (varierar pga Puppeteer-timestamp för identisk template-input).
ALTER TABLE "Document" ADD COLUMN "templateInputHash" TEXT;

-- Sökindex för dedup-fönstret. Även om vi alltid filtrerar med leaseId
-- och category krävs hash-fältet för att index-lookup:en ska träffa
-- direkt utan rad-scan.
CREATE INDEX "Document_leaseId_category_templateInputHash_idx"
  ON "Document" ("leaseId", "category", "templateInputHash");
