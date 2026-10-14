-- KUNDSTART-205 A2 (REQUEST-205-T2, PRE-206-T2): kedjefält och uttryckliga deklarationer.
-- ADDITIV. OpeningPackageRow får två NULLBARA kolumner: befintliga och verkställda rader
-- förblir NULL (uppgiften saknas) – ingen gissad 0. OpeningEvidence är ny i samma serie och
-- tom i alla miljöer; de tre deklarationskolumnerna är därför NOT NULL utan standardvärde.
-- ALTER TABLE ADD COLUMN är DDL och berörs inte av append-only-triggern (BEFORE UPDATE).

-- AlterTable
ALTER TABLE "OpeningPackageRow" ADD COLUMN     "priorCreditedAmount" DECIMAL(12,2),
ADD COLUMN     "priorPaidAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "OpeningEvidence" ADD COLUMN     "declaredSourceOrgNumber" TEXT NOT NULL,
ADD COLUMN     "scopeResponsible" TEXT NOT NULL,
ADD COLUMN     "sourceExportedAt" TIMESTAMP(3) NOT NULL;

