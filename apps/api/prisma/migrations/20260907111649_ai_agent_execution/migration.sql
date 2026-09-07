-- CreateEnum
CREATE TYPE "AiAssignmentEventType" AS ENUM ('UNDO_REQUESTED');

-- OBS: `prisma migrate dev` genererade här ett
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- och det är BORTTAGET med flit. Indexet är ett pgvector-HNSW-index som
-- Prisma inte kan uttrycka i schemat, så varje ny migration vill droppa det.
-- Det är känd drift, inte en ändring den här migrationen ska göra — och att
-- släppa igenom raden hade tagit bort produktionens vektorindex.

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "executionStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "agentExecutionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiAssignmentEvent" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" "AiAssignmentEventType" NOT NULL,
    "handlingAv" "ActorKind" NOT NULL,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssignmentEvent_assignmentId_createdAt_idx" ON "AiAssignmentEvent"("assignmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAssignmentEvent" ADD CONSTRAINT "AiAssignmentEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AiAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── APPEND-ONLY-SPÄRR FÖR AiAssignmentEvent (#585-mekaniken) ────────────────
--
-- Samma funktion och samma form som de elva tabellerna före den: BEFORE UPDATE,
-- FOR EACH STATEMENT, `append_only_guard()`.
--
-- VARFÖR DEN BEHÖVS: docblocket i `schema.prisma` säger att tabellen är
-- append-only. Utan triggern bor den egenskapen bara i vanan — mätt mot riktig
-- Postgres går en sådan rad att UPDATE:a, och en ångra-begäran som kan skrivas
-- om i efterhand är ett sämre spår än inget spår. `check-append-only.mjs`
-- fällde precis den avvikelsen här, vilket är vad den finns för.
--
-- VARFÖR SATSNIVÅ OCH INTE RADNIVÅ: satsnivå räcker när ingen laglig
-- kaskad-UPDATE kan träffa tabellen. `actorUserId` är avsiktligt en NAKEN
-- sträng utan främmande nyckel — precis för att undvika den `ON DELETE SET
-- NULL` som tvingade fram radnivå för `AccountingPeriodEvent` och
-- `TenantAnonymizationLog` i #585. Enda FK:n är `assignmentId`, som är
-- `ON DELETE CASCADE` och alltså aldrig ger en UPDATE.
--
-- DELETE spärras INTE, av samma skäl som i #585: en full spärr hade brutit
-- organisationsraderingen. Raden faller via Cascade från `AiAssignment`.
CREATE TRIGGER append_only_ai_assignment_event
  BEFORE UPDATE ON "AiAssignmentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
