-- TESTKUND-20261004/016 (KRITERIER-H4-016 K3.1): append-only historik över sändförsök och
-- avvisningsbevis per export. Bara tillägg: en ny kolumn med tom lista som standard. Ingen
-- backfill — befintliga rader får [] och ingen påhittad historik.

-- AlterTable
ALTER TABLE "FortnoxVoucherExport" ADD COLUMN "attemptHistory" JSONB NOT NULL DEFAULT '[]';
