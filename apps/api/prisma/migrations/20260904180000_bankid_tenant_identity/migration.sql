-- BankID för hyresgästportalen (#745 PR 4).
--
-- ── TVÅ RADER UR `prisma migrate diff` ÄR MED FLIT BORTTAGNA ────────────────
--
-- Verktyget genererar alltid `CREATE EXTENSION IF NOT EXISTS "vector"` och ett
-- `DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx"`. Ingetdera hör till den
-- här ändringen: HNSW-indexet är ett pgvector-index som Prisma inte kan
-- uttrycka i schemat och som därför ser ut som drift vid varje diff. Tas det
-- med DROPPAS den semantiska sökningens index TYST vid nästa deploy.
--
-- Det här är femte gången fällan gillras. Kontrollen som fångar den är
-- check-critical-indexes.mjs; raderna får aldrig kopieras in.

-- AlterTable
--
-- Envelopen behövs bara i portalflödets kontovals-gren: klartexten finns i den
-- collect som identifierade personen, valet sker i ett senare anrop. Nullbar
-- därför att den är tom i alla andra fall — inte som ett tyst undantag utan som
-- ett fält med en enda, utskriven användning. Se schema.prisma.
ALTER TABLE "BankIdOrder" ADD COLUMN "subjectEnc" TEXT;

-- CreateTable
CREATE TABLE "TenantBankIdIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "subjectEnc" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBankIdIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantBankIdIdentity_tenantId_idx" ON "TenantBankIdIdentity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantBankIdIdentity_provider_subjectHash_tenantId_key" ON "TenantBankIdIdentity"("provider", "subjectHash", "tenantId");

-- CreateIndex
--
-- GLOBALT, INTE UNIKT. Samma person kan vara hyresgäst hos två hyresvärdar, och
-- ett unikt villkor hade gjort den andra hyresvärdens registrering till ett hårt
-- fel. Det org-scopade indexet står kvar och svarar på en annan fråga — se
-- kommentaren vid modellen i schema.prisma.
CREATE INDEX "Tenant_personalNumberHash_idx" ON "Tenant"("personalNumberHash");

-- AddForeignKey
ALTER TABLE "TenantBankIdIdentity" ADD CONSTRAINT "TenantBankIdIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
