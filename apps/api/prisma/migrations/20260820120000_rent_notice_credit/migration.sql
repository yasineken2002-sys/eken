-- #518 — KREDITERING AV HYRESAVI (den obetalda vägen).
--
-- ADDITIV. Ingen befintlig kolumn ändras, ingen befintlig rad rörs, och inget
-- av avins lås luckras upp: @@unique([leaseId, year, month, type]) står orört
-- och "ocrNumber" förblir NOT NULL. Det är hela poängen med att välja en egen
-- tabell i stället för att modellera krediteringen som en RentNotice-rad.
--
-- HANDSKRIVEN, INTE GENERERAD RAKT AV. `prisma migrate diff` tar med två satser
-- som INTE hör till den här ändringen och som funnits som känd drift sedan #513:
--   • CREATE EXTENSION "vector"                       (ofarlig, redan applicerad)
--   • DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx"
-- Den andra är farlig: kolumnen är Unsupported("vector(1024)") och Prisma kan
-- inte uttrycka @@index på den, så schemat "tror" att indexet inte ska finnas.
-- Åker den med faller juridik-RAG:en tyst till sekventiell skanning. Båda är
-- strukna här; kvittering finns i prisma/schema-drift-acknowledged.json.

-- AlterEnum
-- Egen händelsetyp för nedsättningen. `ALTER TYPE ... ADD VALUE` går i
-- transaktion på PostgreSQL 12+ så länge värdet inte ANVÄNDS i samma
-- transaktion — och det gör det inte här.
ALTER TYPE "RentNoticeEventType" ADD VALUE 'CREDITED';

-- CreateTable
CREATE TABLE "RentNoticeCredit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "creditedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticeCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentNoticeCreditLine" (
    "id" TEXT NOT NULL,
    "rentNoticeCreditId" TEXT NOT NULL,
    "rentNoticeLineId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticeCreditLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentNoticeCredit_organizationId_idx" ON "RentNoticeCredit"("organizationId");

-- CreateIndex
CREATE INDEX "RentNoticeCredit_rentNoticeId_idx" ON "RentNoticeCredit"("rentNoticeId");

-- CreateIndex
CREATE INDEX "RentNoticeCreditLine_rentNoticeCreditId_idx" ON "RentNoticeCreditLine"("rentNoticeCreditId");

-- CreateIndex
CREATE INDEX "RentNoticeCreditLine_rentNoticeLineId_idx" ON "RentNoticeCreditLine"("rentNoticeLineId");

-- AddForeignKey
ALTER TABLE "RentNoticeCredit" ADD CONSTRAINT "RentNoticeCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentNoticeCredit" ADD CONSTRAINT "RentNoticeCredit_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentNoticeCreditLine" ADD CONSTRAINT "RentNoticeCreditLine_rentNoticeCreditId_fkey" FOREIGN KEY ("rentNoticeCreditId") REFERENCES "RentNoticeCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentNoticeCreditLine" ADD CONSTRAINT "RentNoticeCreditLine_rentNoticeLineId_fkey" FOREIGN KEY ("rentNoticeLineId") REFERENCES "RentNoticeLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── DB-CHECK, INTE BARA APPLIKATIONSLOGIK ───────────────────────────────────
--
-- En kreditering med negativt eller noll belopp är inte en nedsättning: ett
-- negativt belopp ÖKAR fordran genom `computeRentDebt` (skulden räknas som
-- brutto − paid − credited), alltså motsatsen till vad dokumentet påstår sig
-- göra. Tjänstelagret avvisar det redan, men checken gäller även för ett skript
-- eller en framtida väg som skriver förbi tjänsten. Samma hållning som
-- `Invoice_credit_note_requires_original_chk` på fakturasidan (#528).
--
-- Prisma modellerar inte CHECK-constraints, så de syns inte i schema.prisma och
-- kan inte heller läcka in i `migrate diff`.
ALTER TABLE "RentNoticeCredit" ADD CONSTRAINT "RentNoticeCredit_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "RentNoticeCreditLine" ADD CONSTRAINT "RentNoticeCreditLine_amount_positive_chk" CHECK ("amount" > 0);
