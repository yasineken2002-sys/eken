-- ÅTERUPPTAGNINGSMOTORN, SKUGGLÄGE.
--
-- Tre saker: motorns två utfallstabeller, och LÄSARENS index.
--
-- ── INDEXET FÅR EN LÄSARE FÖRST NU ──────────────────────────────────────────
--
-- `completedAt` lades till utan index med flit: ett index utan läsare är bara
-- skrivkostnad på varje AI-verktygsanrop. Motorn är läsaren, och dess enda
-- fråga är "vilka rader står påbörjade, och hur gamla är de?".
--
-- Därför ett PARTIELLT index på `createdAt` WHERE `completedAt IS NULL`:
--
--   • Predikatet är hela poängen. Mätt i produktion 2026-09-02 står 11 av 11
--     rader som påbörjade — men det är ett övergångsläge (se nedan). När
--     tvåfasvägen fått gå ett tag är den normala andelen påbörjade nära noll,
--     och då är det partiella indexet nästan tomt medan ett fullt index växer
--     med varje verktygsanrop.
--   • Kolumnen är `createdAt` därför att motorn sorterar och grindar på ÅLDER.
--
-- ── VARFÖR TABELLERNA ÄR TVÅ ────────────────────────────────────────────────
--
-- `AiResumptionRun` svarar på "körde motorn, och vad såg den" — även när svaret
-- är noll rader. `AiResumptionVerdict` svarar på "vad blev domen om den här
-- raden, och varför". Utan den första kan en motor som slutat köra inte skiljas
-- från en motor som inte hittar något; utan den andra går utfallet inte att
-- läsa som en lista.
--
-- `AiResumptionVerdict` har `@@unique([executionId])` och UPPDATERAS: en rad per
-- påbörjad körning, inte en per bedömning. De 11 prod-raderna kommer aldrig att
-- stängas, och en rad per körning hade vuxit obegränsat utan att bära ny
-- information.

-- CreateEnum
CREATE TYPE "ResumptionMode" AS ENUM ('SHADOW', 'LIVE');

-- CreateEnum
CREATE TYPE "ResumptionDecision" AS ENUM ('RESUME', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "ResumptionReason" AS ENUM ('PRE_TWO_PHASE', 'UNKNOWN_CLASSIFICATION', 'REQUIRES_HUMAN', 'NO_TRACE', 'TOO_FRESH', 'TOO_OLD', 'QUOTA_BLOCKED', 'RESUMABLE');

-- CreateTable
CREATE TABLE "AiResumptionRun" (
    "id" TEXT NOT NULL,
    "mode" "ResumptionMode" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "resumed" INTEGER NOT NULL DEFAULT 0,
    "abstained" INTEGER NOT NULL DEFAULT 0,
    "reasonCounts" JSONB NOT NULL DEFAULT '{}',
    "failure" TEXT,

    CONSTRAINT "AiResumptionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiResumptionVerdict" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "decision" "ResumptionDecision" NOT NULL,
    "reason" "ResumptionReason" NOT NULL,
    "ageSec" INTEGER NOT NULL,
    "assessments" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiResumptionVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiResumptionRun_startedAt_idx" ON "AiResumptionRun"("startedAt");

-- CreateIndex
CREATE INDEX "AiResumptionVerdict_runId_idx" ON "AiResumptionVerdict"("runId");

-- CreateIndex
CREATE INDEX "AiResumptionVerdict_reason_idx" ON "AiResumptionVerdict"("reason");

-- CreateIndex
CREATE INDEX "AiResumptionVerdict_organizationId_idx" ON "AiResumptionVerdict"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AiResumptionVerdict_executionId_key" ON "AiResumptionVerdict"("executionId");

-- AddForeignKey
ALTER TABLE "AiResumptionVerdict" ADD CONSTRAINT "AiResumptionVerdict_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiResumptionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiResumptionVerdict" ADD CONSTRAINT "AiResumptionVerdict_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── LÄSARENS INDEX ─────────────────────────────────────────────────────────
--
-- Prisma kan inte uttrycka ett partiellt index, så det står i rå SQL och
-- skyddas av `check-critical-indexes.mjs`. Ett index som bara finns i en
-- migration ingen läser är ett index som tyst kan försvinna.
CREATE INDEX "ai_tool_execution_started_idx"
  ON "AiToolExecution" ("createdAt")
  WHERE "completedAt" IS NULL;
