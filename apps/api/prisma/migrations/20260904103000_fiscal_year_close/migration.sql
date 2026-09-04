-- RÄKENSKAPSÅRET SOM ETT EGET STÄNGT TILLSTÅND (#704 PR 1).
--
-- Motiveringen till varför det här inte kan bo i AccountingPeriodEvent står i
-- modellens docblock i schema.prisma. Kort: (year, month) namnger en
-- KALENDERMÅNAD, och ett brutet räkenskapsår spänner över två kalenderår —
-- mätt: startMonth = 5 ger månadsnycklarna 2026-05 … 2027-04 för räkenskapsåret
-- 2026. Det finns inget par som namnger året.
--
-- ── TVÅ RADER BORTTAGNA UR DEN GENERERADE SQL:EN, MED FLIT ──────────────────
--
-- `prisma migrate diff` la in:
--
--     CREATE EXTENSION IF NOT EXISTS "vector";
--     DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
--
-- HNSW-indexet går inte att uttrycka i schema.prisma, så diffen vill ta bort det
-- VARJE gång en migration genereras. Hade raden följt med hade juridik-RAG:ens
-- vektorindex försvunnit i prod — en tyst prestandakollaps utan samband med
-- årsstängning. Samma sak dokumenterad i 20260820120000, 20260822113144 och
-- 20260831212302; det här är fjärde gången fällan gillrats.

-- CreateTable
CREATE TABLE "FiscalYearClose" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "journalEntryId" TEXT,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalYearClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYearClose_journalEntryId_key" ON "FiscalYearClose"("journalEntryId");

-- CreateIndex
CREATE INDEX "FiscalYearClose_organizationId_idx" ON "FiscalYearClose"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYearClose_organizationId_fiscalYear_key" ON "FiscalYearClose"("organizationId", "fiscalYear");

-- AddForeignKey
ALTER TABLE "FiscalYearClose" ADD CONSTRAINT "FiscalYearClose_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalYearClose" ADD CONSTRAINT "FiscalYearClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalYearClose" ADD CONSTRAINT "FiscalYearClose_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── APPEND-ONLY-SPÄRR FÖR FiscalYearClose (#585-mekaniken) ──────────────────
--
-- FOR EACH ROW och `append_only_guard_actor`, INTE satsvarianten: `closedById`
-- är `ON DELETE SET NULL` från "User" (se FK:n ovan), alltså en UPDATE som
-- DATABASEN gör när en användare raderas, utan att koden vet om det. Satsnivån
-- hade fällt den lagliga kaskaden. Samma val och samma skäl som
-- AccountingPeriodEvent och TenantAnonymizationLog i
-- 20260828140000_append_only_event_triggers.
--
-- VARFÖR RADEN MÅSTE VARA OFÖRÄNDERLIG: den bär tidpunkten då ett räkenskapsår
-- låstes och verifikatet som låste det. Går den att UPDATE:a går årsstängningen
-- att flytta i efterhand, och `journalEntryId` att peka om till ett annat
-- verifikat — precis det ett revisionsspår ska omöjliggöra. Följden är att
-- PR 2 måste sätta `journalEntryId` VID INSERT; se kontraktet i schema.prisma.
--
-- DELETE spärras INTE, av samma skäl som i #585: en full spärr hade brutit
-- organisationsraderingen. Organisationsrelationen är Restrict, så
-- delete-organization.ts måste ta raden uttryckligen.
CREATE TRIGGER append_only_fiscal_year_close
  BEFORE UPDATE ON "FiscalYearClose"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard_actor('closedById');
