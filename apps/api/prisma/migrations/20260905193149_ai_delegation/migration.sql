-- DELEGATIONEN (G2, etapp 7) — och grunden varje agentskrivning ska bära.
--
-- ── VARFÖR `authorityKind` ÄR NOT NULL OCH INTE EN NULLBAR PEKARE ───────────
--
-- Det enkla hade varit att bara lägga till `delegationId TEXT` och låta NULL
-- betyda "ingen delegation". Det duger inte, och skälet är det som gör hela
-- fältet värt att ha:
--
--     delegationId IS NULL   betyder "en människa godkände just den här handlingen"
--     delegationId IS NULL   betyder ocksa "raden skrevs innan delegationer fanns"
--     delegationId IS NULL   betyder ocksa "ingen har svarat på fragan"
--
-- Tre påståenden, ett värde. Planens Del 3 kräver motsatsen: en skrivning ska
-- inte kunna representeras som gjord av en agent utan att det samtidigt gar att
-- uttrycka VARFÖR agenten hade rätt. En kolumn som betyder tre saker kan inte
-- uttrycka nagot.
--
-- `authorityKind NOT NULL DEFAULT 'APPROVAL'` gör frågan besvarad för varje rad
-- som finns. Befintliga rader är per definition godkännanden — delegationer
-- fanns inte när de skrevs — så defaulten är ett FAKTUM och inte en gissning.
-- Det är samma familj som `sendId NOT NULL DEFAULT ''` i #656: en sentinel som
-- bevarar den gamla semantiken för de gamla raderna.
--
-- ── STATUS ÄR BERÄKNAD — DÄRFÖR FINNS INGEN STATUSKOLUMN ───────────────────
--
-- `AiDelegation` har med flit ingen `status`. Tillståndet härleds ur
-- `AiDelegationEvent` plus klockan. En lagrad status hade kunnat glida isär
-- från händelserna den sammanfattar, och den avvikelsen är osynlig.
--
-- ── TVÅ RADER UR `prisma migrate diff` ÄR MED FLIT BORTTAGNA ────────────────
--
-- Verktyget genererar alltid `CREATE EXTENSION IF NOT EXISTS "vector"` och ett
-- `DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx"`. HNSW-indexet är ett
-- pgvector-index Prisma inte kan uttrycka och som därför ser ut som drift vid
-- varje diff. Tas det med DROPPAS den semantiska sökningens index TYST vid
-- nästa deploy. check-critical-indexes.mjs fångar det.

-- CreateEnum
CREATE TYPE "AiAuthorityKind" AS ENUM ('APPROVAL', 'DELEGATION');

-- CreateEnum
CREATE TYPE "AiDelegationEventType" AS ENUM ('CREATED', 'PAUSED', 'RESUMED', 'REVOKED', 'EXPIRED', 'EXTENDED');

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "authorityKind" "AiAuthorityKind" NOT NULL DEFAULT 'APPROVAL',
ADD COLUMN     "delegationId" TEXT;

-- AlterTable
ALTER TABLE "AiToolExecution" ADD COLUMN     "authorityKind" "AiAuthorityKind" NOT NULL DEFAULT 'APPROVAL',
ADD COLUMN     "delegationId" TEXT;

-- CreateTable
CREATE TABLE "AiDelegation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "authorityScope" TEXT NOT NULL,
    "villkor" JSONB,
    "frekvensvillkor" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "bornFromAssignmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDelegationEvent" (
    "id" TEXT NOT NULL,
    "delegationId" TEXT NOT NULL,
    "type" "AiDelegationEventType" NOT NULL,
    "handlingAv" "ActorKind" NOT NULL,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDelegationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiDelegation_organizationId_toolName_idx" ON "AiDelegation"("organizationId", "toolName");

-- CreateIndex
CREATE INDEX "AiDelegation_expiresAt_idx" ON "AiDelegation"("expiresAt");

-- CreateIndex
CREATE INDEX "AiDelegationEvent_delegationId_createdAt_idx" ON "AiDelegationEvent"("delegationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "AiDelegation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "AiDelegation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDelegation" ADD CONSTRAINT "AiDelegation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDelegation" ADD CONSTRAINT "AiDelegation_bornFromAssignmentId_fkey" FOREIGN KEY ("bornFromAssignmentId") REFERENCES "AiAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDelegation" ADD CONSTRAINT "AiDelegation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDelegationEvent" ADD CONSTRAINT "AiDelegationEvent_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "AiDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── APPEND-ONLY-SPÄRR FÖR AiDelegationEvent (#585-mekaniken) ───────────────
--
-- Samma funktion och samma form som de tio andra: BEFORE UPDATE, FOR EACH
-- STATEMENT. Återkallelse är en HÄNDELSE och inte en radering — historiken
-- måste kunna bevisa att delegationen existerade, och en rad som gar att skriva
-- om kan inte bevisa nagot.
--
-- SATSNIVÅ RÄCKER HÄR. Radnivå behövdes i #585 för de två tabeller som tog emot
-- `ON DELETE SET NULL` fran User — en UPDATE databasen gör utan att koden vet om
-- det. Den här tabellens enda FK (`delegationId`) är `ON DELETE CASCADE`, och
-- `actorUserId` är en naken kolumn UTAN relation just för att undvika den
-- klassen: en raderad användare far inte kunna skriva om historiken.
--
-- DELETE spärras INTE, av samma skäl som i #585: raden faller via Cascade fran
-- AiDelegation, som i sin tur faller med organisationen.
CREATE TRIGGER append_only_ai_delegation_event
  BEFORE UPDATE ON "AiDelegationEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
